import { describe, expect, it, vi } from "vitest";
import { checkLeaks, dispose, registerDisposer } from "../src/core/rendering/dispose";

// NOTE: `checkLeaks()` reflects a MODULE-LEVEL counter (dev mode only), so it
// accumulates across the whole test run. Every assertion here measures a
// DELTA against a baseline captured at the start of the test rather than an
// absolute value, keeping the tests independent of execution order.

describe("registerDisposer / dispose", () => {
  it("runs a registered teardown when the node is disposed", () => {
    const node = document.createElement("div");
    const teardown = vi.fn();
    registerDisposer(node, teardown);

    dispose(node);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("runs multiple teardowns registered on one node", () => {
    const node = document.createElement("div");
    const a = vi.fn();
    const b = vi.fn();
    registerDisposer(node, a);
    registerDisposer(node, b);

    dispose(node);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — disposing twice does not re-run teardowns", () => {
    const node = document.createElement("div");
    const teardown = vi.fn();
    registerDisposer(node, teardown);

    dispose(node);
    dispose(node);
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a node with no registered disposers", () => {
    const node = document.createElement("div");
    expect(() => dispose(node)).not.toThrow();
  });

  it("disposes descendant nodes' teardowns too", () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);

    const parentTd = vi.fn();
    const childTd = vi.fn();
    registerDisposer(parent, parentTd);
    registerDisposer(child, childTd);

    dispose(parent);
    expect(parentTd).toHaveBeenCalledTimes(1);
    expect(childTd).toHaveBeenCalledTimes(1);
  });

  it("disposes children BEFORE parents (post-order)", () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    const grandchild = document.createElement("em");
    child.appendChild(grandchild);
    parent.appendChild(child);

    const order: string[] = [];
    registerDisposer(parent, () => order.push("parent"));
    registerDisposer(child, () => order.push("child"));
    registerDisposer(grandchild, () => order.push("grandchild"));

    dispose(parent);
    expect(order).toEqual(["grandchild", "child", "parent"]);
  });

  it("disposes a deep tree without stack overflow (iterative traversal)", () => {
    const root = document.createElement("div");
    let current = root;
    const teardowns: ReturnType<typeof vi.fn>[] = [];
    for (let i = 0; i < 2000; i++) {
      const next = document.createElement("div");
      const td = vi.fn();
      teardowns.push(td);
      registerDisposer(next, td);
      current.appendChild(next);
      current = next;
    }

    expect(() => dispose(root)).not.toThrow();
    for (const td of teardowns) expect(td).toHaveBeenCalledTimes(1);
  });

  it("disposes multiple sibling children", () => {
    const parent = document.createElement("ul");
    const tds: ReturnType<typeof vi.fn>[] = [];
    for (let i = 0; i < 5; i++) {
      const li = document.createElement("li");
      const td = vi.fn();
      tds.push(td);
      registerDisposer(li, td);
      parent.appendChild(li);
    }

    dispose(parent);
    for (const td of tds) expect(td).toHaveBeenCalledTimes(1);
  });

  it("swallows errors thrown by a teardown and still runs the rest", () => {
    const node = document.createElement("div");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    registerDisposer(node, bad);
    registerDisposer(node, good);

    expect(() => dispose(node)).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("drains disposers added re-entrantly during disposal", () => {
    const node = document.createElement("div");
    const late = vi.fn();
    const first = vi.fn(() => {
      // Register a NEW disposer on the same node while disposing.
      registerDisposer(node, late);
    });
    registerDisposer(node, first);

    dispose(node);
    expect(first).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("re-entrant dispose() of the same node from within a teardown is safe", () => {
    const node = document.createElement("div");
    const inner = vi.fn();
    const outer = vi.fn(() => {
      // Disposers were snapshotted+deleted before running, so a re-entrant
      // dispose of the same node should not loop or re-run this teardown.
      dispose(node);
    });
    registerDisposer(node, inner);
    registerDisposer(node, outer);

    expect(() => dispose(node)).not.toThrow();
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("a disposer mutating the DOM tree mid-traversal does not skip siblings", () => {
    const parent = document.createElement("div");
    const a = document.createElement("span");
    const b = document.createElement("span");
    parent.appendChild(a);
    parent.appendChild(b);

    const aTd = vi.fn(() => {
      // Remove self mid-cleanup — childNodes was snapshotted so b still runs.
      a.remove();
    });
    const bTd = vi.fn();
    registerDisposer(a, aTd);
    registerDisposer(b, bTd);

    dispose(parent);
    expect(aTd).toHaveBeenCalledTimes(1);
    expect(bTd).toHaveBeenCalledTimes(1);
  });
});

describe("checkLeaks (dev-mode counter)", () => {
  it("increments the active binding count per registered disposer", () => {
    const before = checkLeaks();
    const node = document.createElement("div");
    registerDisposer(node, () => {});
    registerDisposer(node, () => {});
    expect(checkLeaks() - before).toBe(2);
    dispose(node);
  });

  it("decrements the count back to baseline after dispose", () => {
    const before = checkLeaks();
    const node = document.createElement("div");
    registerDisposer(node, () => {});
    expect(checkLeaks()).toBeGreaterThan(before);

    dispose(node);
    expect(checkLeaks()).toBe(before);
  });

  it("returns a non-negative number", () => {
    expect(checkLeaks()).toBeGreaterThanOrEqual(0);
  });

  it("does not warn when below threshold", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    checkLeaks(1_000_000);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("warns when the active count exceeds the given threshold", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const node = document.createElement("div");
    // Register enough disposers that the count is comfortably above a small
    // positive threshold (the warn guard requires warnThreshold > 0 AND
    // count > warnThreshold).
    for (let i = 0; i < 5; i++) registerDisposer(node, () => {});

    const current = checkLeaks();
    expect(current).toBeGreaterThan(1);
    checkLeaks(current - 1);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    dispose(node);
  });

  it("does not warn when threshold argument is 0 (the default)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const node = document.createElement("div");
    registerDisposer(node, () => {});

    checkLeaks(0);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    dispose(node);
  });

  it("count is unaffected by disposing a node with no disposers", () => {
    const before = checkLeaks();
    dispose(document.createElement("div"));
    expect(checkLeaks()).toBe(before);
  });
});
