// @vitest-environment node
//
// Evidence for the declared engine floor — documentation, not runtime branching.
//
// `package.json` declares `engines.node: ">=22.3.0"`. That number exists for one
// concrete reason: SSR request isolation needs `AsyncLocalStorage`, and under
// ESM the only synchronous way to load a builtin module is
// `process.getBuiltinModule`, which arrived in Node 22.3.0. Below it the ESM
// build cannot obtain ALS at all, so concurrent requests share a single store —
// cross-request data bleed (NODE-002).
//
// This file pins the CAPABILITY the floor is chosen for, and proves that the
// capability actually delivers isolation on the runtime being tested. It
// deliberately does NOT assert a version string: nothing in the framework
// branches on `process.versions.node`, and a test that did would drift from the
// implementation the first time the detection strategy changed.
//
// The 22.2.0-vs-22.3.0 boundary itself is measured out-of-band by
// `scripts/certify/node-probes/engine-floor.mjs`, which runs against
// hand-installed builds rather than in the normal suite.
import { describe, expect, it } from "vitest";
import { getRequestScopedCache, runInSSRContext } from "../src/core/ssr-context";

describe("engine floor (Node >= 22.3.0)", () => {
  it("provides the capability the floor was chosen for", () => {
    // If this ever fails on a runtime inside the declared range, either the
    // range or the detection strategy is wrong — not this test.
    expect(typeof process.getBuiltinModule).toBe("function");
  });

  it("can load node:async_hooks synchronously, which is what ESM needs", () => {
    const mod = process.getBuiltinModule("node:async_hooks");
    expect(mod).toBeTruthy();
    expect(typeof (mod as { AsyncLocalStorage?: unknown }).AsyncLocalStorage).toBe("function");
  });

  it("does not rely on a global-scope require, which never worked", () => {
    // The pre-22.3 fallback was
    // `Function("return typeof require === 'function' ? require : null")()`.
    // `Function` evaluates its body in GLOBAL scope, where `require` exists in
    // neither module system — so it returned null on every Node version, in both
    // formats. Pinned here so it is never reintroduced as a "fix" for old Node.
    const globalScopeRequire = Function("return typeof require === 'function' ? require : null")();
    expect(globalScopeRequire).toBeNull();
  });

  it("delivers real request isolation across an interleaved await", () => {
    // Constructing an AsyncLocalStorage proves nothing. Isolation only means
    // something when two requests genuinely interleave: A starts, B starts,
    // B completes, A resumes.
    const order: string[] = [];

    const run = (tag: string, delayMs: number) =>
      runInSSRContext(async () => {
        order.push(`${tag}:start`);
        const before = getRequestScopedCache("query");
        await new Promise((r) => setTimeout(r, delayMs));
        order.push(`${tag}:resume`);
        return { tag, before, after: getRequestScopedCache("query") };
      });

    return Promise.all([run("A", 30), run("B", 5)]).then(([a, b]) => {
      // Guard the premise: if the two requests ran to completion one after the
      // other, the isolation assertions below would hold vacuously.
      expect(order).toEqual(["A:start", "B:start", "B:resume", "A:resume"]);

      expect(a.after, "request A resolved to the process-global cache").not.toBeNull();
      expect(b.after, "request B resolved to the process-global cache").not.toBeNull();
      expect(a.after, "A and B shared one cache map").not.toBe(b.after);

      // The scope must survive the await — that is the whole ALS guarantee.
      expect(a.before).toBe(a.after);
      expect(b.before).toBe(b.after);
    });
  });
});
