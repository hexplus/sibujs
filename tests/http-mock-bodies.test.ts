// @vitest-environment node
//
// Runs under Node so FormData, Blob, URLSearchParams and Request are the same
// (native) implementations, as they are in a browser or a Node test runner.

import { afterEach, describe, expect, it } from "vitest";
import { createHttpMock } from "../src/testing/e2e";

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

async function capture(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  let received: unknown;
  const mock = createHttpMock([
    {
      method: "POST",
      url: "/upload",
      response: ({ body }) => {
        received = body;
        return { body: "ok" };
      },
    },
  ]);
  mock.install();
  try {
    await fetch(input, init);
  } finally {
    mock.restore();
  }
  return received;
}

const URL_ = "https://example.test/upload";

describe("createHttpMock gives handlers the same body type for equivalent requests", () => {
  it("FormData", async () => {
    const make = () => {
      const form = new FormData();
      form.append("name", "Ada");
      return form;
    };
    const fromInit = await capture(URL_, { method: "POST", body: make() });
    const request = new Request(URL_, { method: "POST", body: make() });
    const fromRequest = await capture(request);

    for (const body of [fromInit, fromRequest]) {
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get("name")).toBe("Ada");
    }
    expect(request.bodyUsed).toBe(false);
  });

  it("URLSearchParams", async () => {
    const fromInit = await capture(URL_, { method: "POST", body: new URLSearchParams("a=1&b=2") });
    const request = new Request(URL_, { method: "POST", body: new URLSearchParams("a=1&b=2") });
    const fromRequest = await capture(request);

    for (const body of [fromInit, fromRequest]) {
      expect(body).toBeInstanceOf(URLSearchParams);
      expect((body as URLSearchParams).get("b")).toBe("2");
    }
    expect(request.bodyUsed).toBe(false);
  });

  it("binary Blob", async () => {
    const make = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const fromInit = await capture(URL_, { method: "POST", body: make() });
    const request = new Request(URL_, { method: "POST", body: make() });
    const fromRequest = await capture(request);

    for (const body of [fromInit, fromRequest]) {
      expect(body).toBeInstanceOf(Blob);
      expect([...new Uint8Array(await (body as Blob).arrayBuffer())]).toEqual([1, 2, 3]);
    }
    expect(request.bodyUsed).toBe(false);
  });

  it("binary buffers", async () => {
    for (const make of [() => new Uint8Array([7, 8]).buffer, () => new Uint8Array([7, 8])]) {
      const fromInit = await capture(URL_, { method: "POST", body: make() });
      const request = new Request(URL_, { method: "POST", body: make() });
      const fromRequest = await capture(request);

      for (const body of [fromInit, fromRequest]) {
        expect(body).toBeInstanceOf(Blob);
        expect([...new Uint8Array(await (body as Blob).arrayBuffer())]).toEqual([7, 8]);
      }
      expect(request.bodyUsed).toBe(false);
    }
  });

  it("JSON and plain text", async () => {
    const json = JSON.stringify({ value: 1 });
    expect(await capture(URL_, { method: "POST", body: json })).toEqual({ value: 1 });
    expect(await capture(new Request(URL_, { method: "POST", body: json }))).toEqual({ value: 1 });
    expect(await capture(URL_, { method: "POST", body: "hello" })).toBe("hello");
    expect(await capture(new Request(URL_, { method: "POST", body: "hello" }))).toBe("hello");
  });

  it("init headers supersede the Request's content type for body interpretation", async () => {
    const seen: Array<{ type: string | null; body: unknown }> = [];
    const mock = createHttpMock([
      {
        method: "POST",
        url: "/upload",
        response: ({ body, headers }) => {
          seen.push({ type: headers.get("content-type"), body });
          return { body: "ok" };
        },
      },
    ]);
    mock.install();
    try {
      const binaryTyped = new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: JSON.stringify({ value: 1 }),
      });
      await fetch(binaryTyped, { headers: { "content-type": "application/json" } });
      expect(binaryTyped.bodyUsed).toBe(false);

      const jsonTyped = new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 2 }),
      });
      await fetch(jsonTyped, { headers: { "content-type": "application/octet-stream" } });
      expect(jsonTyped.bodyUsed).toBe(false);
    } finally {
      mock.restore();
    }

    expect(seen[0]).toEqual({ type: "application/json", body: { value: 1 } });
    expect(seen[1].type).toBe("application/octet-stream");
    expect(seen[1].body).toBeInstanceOf(Blob);
    expect(await (seen[1].body as Blob).text()).toBe('{"value":2}');
  });

  it("text-typed blobs decode as text either way", async () => {
    const make = () => new Blob(["plain"], { type: "text/plain" });
    expect(await capture(URL_, { method: "POST", body: make() })).toBe("plain");
    expect(await capture(new Request(URL_, { method: "POST", body: make() }))).toBe("plain");
  });
});
