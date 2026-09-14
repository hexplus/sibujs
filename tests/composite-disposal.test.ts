import { afterEach, describe, expect, it } from "vitest";
import { signal } from "../src/core/signals/signal";
import { getActiveDevTools, initDevTools } from "../src/devtools/devtools";
import { getSubscriberCount } from "../src/devtools/introspect";
import { timeline } from "../src/patterns/timeTravel";
import { pagination } from "../src/ui/pagination";

type Hook = { nodes: Map<number, { type: string }> };

const computedCount = (): number =>
  [
    ...(globalThis as unknown as { __SIBU_DEVTOOLS_GLOBAL_HOOK__: Hook }).__SIBU_DEVTOOLS_GLOBAL_HOOK__.nodes.values(),
  ].filter((n) => n.type === "computed").length;

afterEach(() => {
  getActiveDevTools()?.destroy();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__SIBU__;
  delete (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS__;
});

describe("pagination().dispose()", () => {
  it("releases totalItems, removes its four DevTools entries and freezes the result", () => {
    initDevTools();
    const [totalItems, setTotalItems] = signal(95);
    const pager = pagination({ totalItems, pageSize: 10, initialPage: 3 });

    expect(pager.totalPages()).toBe(10);
    expect(pager.page()).toBe(3);
    expect(pager.startIndex()).toBe(20);
    expect(pager.endIndex()).toBe(30);
    expect(getSubscriberCount(totalItems)).toBe(2);
    expect(computedCount()).toBe(4);

    pager.dispose();

    expect(getSubscriberCount(totalItems)).toBe(0);
    expect(computedCount()).toBe(0);

    // A retained result keeps returning its last values.
    setTotalItems(5);
    pager.next();
    expect(pager.totalPages()).toBe(10);
    expect(pager.page()).toBe(3);
    expect(pager.startIndex()).toBe(20);
    expect(pager.endIndex()).toBe(30);
    expect(getSubscriberCount(totalItems)).toBe(0);

    expect(() => pager.dispose()).not.toThrow();
    expect(computedCount()).toBe(0);
  });

  it("does not affect another pagination reading the same source", () => {
    const [totalItems, setTotalItems] = signal(50);
    const discarded = pagination({ totalItems, pageSize: 10 });
    const kept = pagination({ totalItems, pageSize: 10 });
    expect(getSubscriberCount(totalItems)).toBe(4);

    discarded.dispose();
    expect(getSubscriberCount(totalItems)).toBe(2);

    setTotalItems(100);
    expect(kept.totalPages()).toBe(10);
    kept.dispose();
    expect(getSubscriberCount(totalItems)).toBe(0);
  });
});

describe("timeline().dispose()", () => {
  it("removes its three DevTools entries and freezes the derived values", () => {
    initDevTools();
    const t = timeline(0);
    t.set(1);
    expect(t.value()).toBe(1);
    expect(t.canUndo()).toBe(true);
    expect(t.canRedo()).toBe(false);
    expect(computedCount()).toBe(3);

    t.dispose();
    expect(computedCount()).toBe(0);

    t.undo();
    expect(t.value()).toBe(1);
    expect(t.canUndo()).toBe(true);
    expect(() => t.dispose()).not.toThrow();
  });
});
