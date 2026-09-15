// @vitest-environment node
//
// Runs under Node so FormData, Blob, URLSearchParams and Request are the same
// (native) implementations, as they are in a browser or a Node test runner.

import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("a typed Blob with an overriding content type is decoded by the override through both overloads", async () => {
    const headers = { "content-type": "application/octet-stream" };
    const make = () => new Blob(["hello"], { type: "text/plain" });
    const direct = await capture(URL_, { method: "POST", headers, body: make() });
    const request = new Request(URL_, { method: "POST", headers, body: make() });
    const wrapped = await capture(request);

    for (const body of [direct, wrapped]) {
      expect(body).toBeInstanceOf(Blob);
      expect(await (body as Blob).text()).toBe("hello");
    }
    expect(request.bodyUsed).toBe(false);
  });

  it("FormData with an explicit non-multipart type is decoded by that type", async () => {
    const make = () => {
      const form = new FormData();
      form.append("name", "Ada");
      return form;
    };
    const headers = { "content-type": "application/octet-stream" };
    const direct = await capture(URL_, { method: "POST", headers, body: make() });
    const request = new Request(URL_, { method: "POST", headers, body: make() });
    const wrapped = await capture(request);

    for (const body of [direct, wrapped]) {
      expect(body).toBeInstanceOf(Blob);
      expect(await (body as Blob).text()).toContain('name="name"');
    }
    expect(request.bodyUsed).toBe(false);
  });

  it("URLSearchParams with an overriding type is decoded by that type", async () => {
    const headers = { "content-type": "text/plain" };
    const direct = await capture(URL_, { method: "POST", headers, body: new URLSearchParams("a=1") });
    const request = new Request(URL_, { method: "POST", headers, body: new URLSearchParams("a=1") });
    const wrapped = await capture(request);

    expect(direct).toBe("a=1");
    expect(wrapped).toBe("a=1");
    expect(request.bodyUsed).toBe(false);
  });

  it("handlers see the Content-Type fetch generates for structured bodies", async () => {
    const seen: Array<string | null> = [];
    const mock = createHttpMock([
      {
        method: "POST",
        url: "/upload",
        response: ({ headers }) => {
          seen.push(headers.get("content-type"));
          return { body: "ok" };
        },
      },
    ]);
    mock.install();
    const form = new FormData();
    form.append("name", "Ada");
    const request = new Request(URL_, { method: "POST", body: new Blob(["x"], { type: "image/png" }) });
    try {
      await fetch(URL_, { method: "POST", body: form });
      await fetch(URL_, { method: "POST", body: new URLSearchParams("a=1") });
      await fetch(URL_, { method: "POST", body: new Blob(["x"], { type: "image/png" }) });
      await fetch(request);
    } finally {
      mock.restore();
    }

    expect(seen[0]).toMatch(/^multipart\/form-data; boundary=.+/);
    expect(seen[1]).toMatch(/^application\/x-www-form-urlencoded/);
    expect(seen[2]).toBe("image/png");
    expect(seen[3]).toBe("image/png");
    expect(request.bodyUsed).toBe(false);
  });

  describe("signal inheritance from an input Request", () => {
    const abortedRequest = () => {
      const controller = new AbortController();
      const request = new Request("https://example.test/x", { signal: controller.signal });
      controller.abort();
      return request;
    };
    const withMock = async (run: (handler: ReturnType<typeof vi.fn>) => Promise<void>) => {
      const handler = vi.fn(() => ({ body: "ok" }));
      const mock = createHttpMock([{ method: "GET", url: "/x", response: handler }]);
      mock.install();
      try {
        await run(handler);
      } finally {
        mock.restore();
      }
    };

    it("explicit signal: null detaches, so an aborted input Request still reaches the handler", async () => {
      await withMock(async (handler) => {
        const response = await fetch(abortedRequest(), { signal: null });
        expect(await response.text()).toBe("ok");
        expect(handler).toHaveBeenCalledTimes(1);
      });
    });

    it("an omitted or undefined signal inherits the input's abort", async () => {
      await withMock(async (handler) => {
        await expect(fetch(abortedRequest())).rejects.toMatchObject({ name: "AbortError" });
        await expect(fetch(abortedRequest(), {})).rejects.toMatchObject({ name: "AbortError" });
        await expect(fetch(abortedRequest(), { signal: undefined })).rejects.toMatchObject({ name: "AbortError" });
        expect(handler).not.toHaveBeenCalled();
      });
    });

    it("init members are read once, so an accessor cannot answer differently on a second read", async () => {
      await withMock(async (handler) => {
        const live = new AbortController();
        const aborted = new AbortController();
        aborted.abort();
        const reads = { signal: 0, method: 0, headers: 0, body: 0 };
        const init = {
          get signal() {
            reads.signal++;
            return reads.signal === 1 ? live.signal : aborted.signal;
          },
          get method() {
            reads.method++;
            return "GET";
          },
          get headers() {
            reads.headers++;
            return { "x-read": String(reads.headers) };
          },
          get body() {
            reads.body++;
            return undefined;
          },
        };

        const response = await fetch("https://example.test/x", init as RequestInit);
        expect(await response.text()).toBe("ok");
        expect(handler).toHaveBeenCalledTimes(1);
        expect(reads).toEqual({ signal: 1, method: 1, headers: 1, body: 1 });
      });
    });

    it("an explicit non-null signal overrides the input's", async () => {
      await withMock(async (handler) => {
        const live = new AbortController();
        expect(await (await fetch(abortedRequest(), { signal: live.signal })).text()).toBe("ok");

        const aborted = new AbortController();
        aborted.abort();
        const request = new Request("https://example.test/x");
        await expect(fetch(request, { signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(handler).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("text-typed blobs decode as text either way", async () => {
    const make = () => new Blob(["plain"], { type: "text/plain" });
    expect(await capture(URL_, { method: "POST", body: make() })).toBe("plain");
    expect(await capture(new Request(URL_, { method: "POST", body: make() }))).toBe("plain");
  });
});
