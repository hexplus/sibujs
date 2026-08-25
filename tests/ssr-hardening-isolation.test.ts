/**
 * P0 — SSR cross-request isolation and escaping.
 *
 * Governing invariant (§73):
 *
 *   Request-specific SibuJS state may never leak between concurrent SSR
 *   renders.
 *
 * A Node server handles many users in one process, so any module-level mutable
 * request state is a release-blocking defect. These tests interleave renders
 * deliberately rather than running them back to back.
 */
import { describe, expect, it } from "vitest";
import { div, span } from "../src/core/rendering/html";
import { getSSRStore, isSSR, runInSSRContext, withSSR } from "../src/core/ssr-context";
import { escapeScriptJson, renderToString, serializeState } from "../src/platform/ssr";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("SSR isolation: concurrent requests", () => {
  it("keeps SSR state independent across interleaved renders", async () => {
    const gateA = deferred<void>();
    const gateB = deferred<void>();
    const observed: Record<string, unknown> = {};

    // Request A parks mid-render; B runs to completion; then A resumes.
    const requestA = runInSSRContext(async () => {
      const store = getSSRStore();
      store.suspenseIdCounter = 100;
      observed.aBeforePark = store.suspenseIdCounter;

      await gateA.promise;

      // After B has come and gone, A's store must be untouched.
      observed.aAfterResume = getSSRStore().suspenseIdCounter;
      observed.aStillSSR = isSSR();
      return "A";
    });

    const requestB = runInSSRContext(async () => {
      const store = getSSRStore();
      observed.bInitialCounter = store.suspenseIdCounter;
      store.suspenseIdCounter = 500;
      await gateB.promise;
      observed.bAfterResume = getSSRStore().suspenseIdCounter;
      return "B";
    });

    gateB.resolve();
    await requestB;
    gateA.resolve();
    await requestA;

    // B started from a fresh store, not A's mutated one.
    expect(observed.bInitialCounter).toBe(0);
    // A's state survived B entirely.
    expect(observed.aBeforePark).toBe(100);
    expect(observed.aAfterResume).toBe(100);
    expect(observed.bAfterResume).toBe(500);
    expect(observed.aStillSSR).toBe(true);
  });

  it("does not leak the SSR flag out of a request scope", async () => {
    expect(isSSR()).toBe(false);

    await runInSSRContext(async () => {
      expect(isSSR()).toBe(true);
      await Promise.resolve();
      expect(isSSR()).toBe(true);
    });

    // Outside any request the process-level flag must remain off.
    expect(isSSR()).toBe(false);
  });

  it("isolates request-scoped caches between concurrent renders", async () => {
    const { getRequestScopedCache } = await import("../src/core/ssr-context");
    const gate = deferred<void>();
    const seen: Record<string, unknown> = {};

    const a = runInSSRContext(async () => {
      getRequestScopedCache<string>("query")!.set("user", "Alice");
      await gate.promise;
      seen.a = getRequestScopedCache<string>("query")!.get("user");
    });

    const b = runInSSRContext(async () => {
      const cache = getRequestScopedCache<string>("query")!;
      seen.bSawAlice = cache.has("user");
      cache.set("user", "Bob");
      seen.b = cache.get("user");
    });

    await b;
    gate.resolve();
    await a;

    expect(seen.bSawAlice).toBe(false);
    expect(seen.a).toBe("Alice");
    expect(seen.b).toBe("Bob");
  });

  it("keeps 100 interleaved renders free of cross-contamination", async () => {
    const COUNT = 100;
    const gates = Array.from({ length: COUNT }, () => deferred<void>());

    const renders = gates.map((gate, i) =>
      runInSSRContext(async () => {
        const store = getSSRStore();
        store.suspenseIdCounter = i;
        await gate.promise;
        // Render this request's own unique content after the interleave.
        const html = renderToString(div({ id: `req-${i}` }, `user-${i}`) as HTMLElement);
        return { i, counter: getSSRStore().suspenseIdCounter, html };
      }),
    );

    // Release in reverse order to maximise interleaving.
    for (let i = COUNT - 1; i >= 0; i--) gates[i].resolve();
    const results = await Promise.all(renders);

    for (const { i, counter, html } of results) {
      expect(counter).toBe(i);
      expect(html).toContain(`req-${i}`);
      expect(html).toContain(`user-${i}`);
      // No other request's marker may appear in this output.
      for (let j = 0; j < COUNT; j++) {
        if (j !== i) expect(html).not.toContain(`req-${j}"`);
      }
    }
  });

  it("documents that withSSR() alone is NOT request-scoped", async () => {
    // withSSR mutates whatever store is current. Outside runInSSRContext that
    // is the process-global fallback — correct for a one-shot render, but not
    // safe for concurrent requests. This pins the distinction so it cannot
    // regress into a silent footgun.
    expect(isSSR()).toBe(false);
    withSSR(() => {
      expect(isSSR()).toBe(true);
    });
    expect(isSSR()).toBe(false);
  });
});

describe("SSR security: HTML escaping", () => {
  const HOSTILE = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "</script><script>alert(1)</script>",
    '"><script>alert(1)</script>',
    "javascript:alert(1)",
    "&<>\"'",
  ];

  it("escapes hostile text content", () => {
    for (const payload of HOSTILE) {
      const html = renderToString(div(payload) as HTMLElement);

      // The raw payload must never appear as live markup.
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).not.toContain("<img src=x onerror=alert(1)>");
      // Angle brackets from user data must be entity-encoded.
      if (payload.includes("<")) expect(html).toContain("&lt;");
    }
  });

  it("escapes hostile attribute values", () => {
    for (const payload of HOSTILE) {
      const html = renderToString(div({ id: "t", title: payload }, "x") as HTMLElement);

      // The attribute must not be able to break out of its quotes.
      const attrMatch = html.match(/title="([^"]*)"/);
      expect(attrMatch).not.toBeNull();
      expect(attrMatch?.[1]).not.toContain('"');
      expect(html).not.toContain("<script>alert(1)</script>");
    }
  });

  it("escapes hostile data attributes", () => {
    const html = renderToString(div({ "data-user": '"><script>alert(1)</script>' }, "x") as HTMLElement);
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("escapes hostile nested content", () => {
    const html = renderToString(div({}, span("<script>alert(1)</script>") as Node) as HTMLElement);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("preserves legitimate Unicode and emoji", () => {
    const html = renderToString(div("héllo ✓ 🎉 日本語") as HTMLElement);
    expect(html).toContain("héllo");
    expect(html).toContain("✓");
    expect(html).toContain("🎉");
    expect(html).toContain("日本語");
  });
});

describe("SSR security: serialized state", () => {
  it("prevents attacker data from closing the script tag", () => {
    const html = serializeState({ payload: "</script><script>alert(1)</script>" });

    // Exactly one opening and one closing script tag.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c");
  });

  it("escapes HTML comment sequences", () => {
    const html = serializeState({ a: "<!--", b: "-->", c: "<!--<script>" });
    expect(html).not.toContain("<!--");
    expect(html).not.toContain("-->");
  });

  it("escapes U+2028 and U+2029 line terminators", () => {
    const html = serializeState({ a: "line break", b: "para break" });
    expect(html).not.toContain(" ");
    expect(html).not.toContain(" ");
    expect(html).toContain("\\u2028");
    expect(html).toContain("\\u2029");
  });

  it("round-trips hostile values back to their original form", () => {
    const state = {
      xss: "</script><script>alert(1)</script>",
      unicode: "line break",
      quotes: `"'\\`,
      amp: "a&b<c>d",
    };
    const html = serializeState(state);

    // Extract the JSON payload and verify it parses back identically.
    const json = html.replace(/^<script>window\.[^=]+=/, "").replace(/<\/script>$/, "");
    const decoded = JSON.parse(
      json
        .replace(/\\u003c/g, "<")
        .replace(/\\u003e/g, ">")
        .replace(/\\u0026/g, "&")
        .replace(/\\u2028/g, " ")
        .replace(/\\u2029/g, " "),
    );
    expect(decoded).toEqual(state);
  });

  it("escapes a nonce attribute", () => {
    const html = serializeState({ a: 1 }, '"><script>alert(1)</script>');
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("rejects an oversized payload rather than emitting it", () => {
    const huge = { data: "x".repeat(2 * 1024 * 1024) };
    expect(() => serializeState(huge)).toThrow(/exceeds maxBytes/);
  });

  it("escapeScriptJson neutralises every script-terminating character", () => {
    const out = escapeScriptJson('{"a":"</script><!--&"}');
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).not.toContain("&");
  });
});
