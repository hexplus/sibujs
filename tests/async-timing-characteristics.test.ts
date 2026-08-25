/**
 * Async-timing characteristic that SSR bootstrap tests depend on.
 *
 * A client navigation settles on microtasks; `hydrateRouter()`'s dynamic
 * `import()` does not. A bootstrap test that drains only microtasks therefore
 * observes the state *while the bootstrap is still pending*, which is what makes
 * the RM-002 race assertions meaningful rather than vacuous.
 *
 * Only the ordering is asserted, never absolute timing — how many macrotasks a
 * module resolution needs varies with load, and asserting that made this test
 * flaky under the full suite.
 */
import { describe, expect, it } from "vitest";
import { createRouter, destroyRouter, navigate } from "../src/plugins/router";

describe("bootstrap test harness: async timing characteristics", () => {
  it("settles a navigation on microtasks, before a dynamic import resolves", async () => {
    const order: string[] = [];
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });

    try {
      void import("../src/platform/ssr").then(() => order.push("import"));
      void navigate("/x").then(() => order.push("navigation"));

      // Microtasks only: the navigation lands, the import cannot.
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(order).toEqual(["navigation"]);

      // Bounded wait — the import resolves eventually; how many macrotasks it
      // needs is load-dependent and deliberately not asserted.
      for (let i = 0; i < 50 && !order.includes("import"); i++) {
        await new Promise((r) => setTimeout(r, 1));
      }
      expect(order).toEqual(["navigation", "import"]);
    } finally {
      destroyRouter();
    }
  });
});
