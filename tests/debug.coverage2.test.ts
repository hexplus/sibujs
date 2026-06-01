import { describe, expect, it, vi } from "vitest";
import { checkLeaks, runCleanups, trackCleanup } from "../src/devtools/debug";

// Covers the previously-uncovered runCleanups path: running tracked cleanups,
// swallowing a cleanup that throws (console.warn), and clearing the entry.

describe("runCleanups", () => {
  it("runs all tracked cleanups for a component and clears them", () => {
    const order: string[] = [];
    trackCleanup("Widget", () => order.push("a"));
    trackCleanup("Widget", () => order.push("b"));

    runCleanups("Widget");

    expect(order).toEqual(["a", "b"]);
    // After running, the component has no pending cleanups (no leak entry).
    expect(checkLeaks().Widget).toBeUndefined();
  });

  it("swallows errors thrown by a cleanup and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      trackCleanup("Boomer", () => {
        throw new Error("cleanup failed");
      });
      let after = false;
      trackCleanup("Boomer", () => {
        after = true;
      });

      expect(() => runCleanups("Boomer")).not.toThrow();
      expect(after).toBe(true);
      expect(warn).toHaveBeenCalledWith("[SibuJS debug] cleanup threw:", expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it("is a no-op for an unknown component", () => {
    expect(() => runCleanups("never-registered")).not.toThrow();
  });
});
