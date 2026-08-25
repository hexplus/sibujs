/**
 * Async-timing characteristics that SSR bootstrap tests depend on.
 *
 * These are not framework guarantees — they are properties of the harness that
 * make bootstrap race tests either meaningful or silently vacuous. They are
 * pinned here because getting them wrong produces tests that pass for the wrong
 * reason, which happened twice while writing the RM-002 suite:
 *
 *  - a client navigation settles on microtasks;
 *  - `hydrateRouter()`'s dynamic `import()` continuation needs a macrotask,
 *    even when the module is already warm.
 *
 * A bootstrap test that drains only microtasks therefore observes the state
 * *while the bootstrap is still pending*, and one that awaits macrotasks
 * observes the state *after* it has resolved. Confusing the two makes assertions
 * measure nothing.
 */
import { describe, expect, it } from "vitest";
import { createRouter, destroyRouter, navigate } from "../src/plugins/router";

describe("bootstrap test harness: async timing characteristics", () => {
  it("a navigation settles on microtasks while a dynamic import does not", async () => {
    const order: string[] = [];
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });

    try {
      void import("../src/platform/ssr").then(() => order.push("import"));
      void navigate("/x").then(() => order.push("navigation"));

      // Microtasks only.
      for (let i = 0; i < 30; i++) await Promise.resolve();

      expect(order).toContain("navigation");
      expect(order).not.toContain("import");

      // Now allow macrotasks.
      await new Promise((r) => setTimeout(r, 0));
      for (let i = 0; i < 8; i++) await Promise.resolve();

      expect(order).toContain("import");
    } finally {
      destroyRouter();
    }
  });
});
