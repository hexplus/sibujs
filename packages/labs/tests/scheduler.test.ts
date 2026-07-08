import { describe, expect, it, vi } from "vitest";
import {
  flushScheduler,
  Priority,
  pendingTasks,
  processInChunks,
  scheduleUpdate,
  yieldToMain,
} from "../src/performance/scheduler";

describe("Scheduler", () => {
  it("should execute IMMEDIATE tasks synchronously", () => {
    const fn = vi.fn();
    scheduleUpdate(Priority.IMMEDIATE, fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("should queue and flush normal priority tasks", () => {
    const fn = vi.fn();
    scheduleUpdate(Priority.NORMAL, fn);

    expect(fn).not.toHaveBeenCalled();
    expect(pendingTasks()).toBe(1);

    flushScheduler();
    expect(fn).toHaveBeenCalledOnce();
    expect(pendingTasks()).toBe(0);
  });

  it("should execute tasks in priority order", () => {
    const order: number[] = [];

    scheduleUpdate(Priority.LOW, () => order.push(3));
    scheduleUpdate(Priority.USER_BLOCKING, () => order.push(1));
    scheduleUpdate(Priority.NORMAL, () => order.push(2));

    flushScheduler();
    expect(order).toEqual([1, 2, 3]);
  });

  it("should support task cancellation", () => {
    const fn = vi.fn();
    const cancel = scheduleUpdate(Priority.NORMAL, fn);

    cancel();
    flushScheduler();
    expect(fn).not.toHaveBeenCalled();
  });
});

// ============================================================================
// yieldToMain
// ============================================================================

describe("yieldToMain", () => {
  it("should return a promise", () => {
    const result = yieldToMain();
    expect(result).toBeInstanceOf(Promise);
  });

  it("should resolve after yielding", async () => {
    const order: number[] = [];
    order.push(1);
    await yieldToMain();
    order.push(2);
    expect(order).toEqual([1, 2]);
  });
});

// ============================================================================
// processInChunks
// ============================================================================

describe("processInChunks", () => {
  it("should process all items", async () => {
    const items = [1, 2, 3, 4, 5];
    const processed: number[] = [];

    await processInChunks(items, (item) => {
      processed.push(item);
    });

    expect(processed).toEqual([1, 2, 3, 4, 5]);
  });

  it("should invoke processor with correct index", async () => {
    const items = ["a", "b", "c"];
    const indices: number[] = [];

    await processInChunks(items, (_item, index) => {
      indices.push(index);
    });

    expect(indices).toEqual([0, 1, 2]);
  });

  it("should handle empty array", async () => {
    const processed: number[] = [];
    await processInChunks([], (item: number) => processed.push(item));
    expect(processed).toEqual([]);
  });

  it("should respect custom chunk size", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const processed: number[] = [];

    await processInChunks(items, (item) => processed.push(item), 3);
    expect(processed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("should yield between chunks for large arrays", async () => {
    const items = Array.from({ length: 120 }, (_, i) => i);
    const processed: number[] = [];

    await processInChunks(items, (item) => processed.push(item), 50);
    // All items should be processed despite yielding
    expect(processed.length).toBe(120);
    expect(processed[0]).toBe(0);
    expect(processed[119]).toBe(119);
  });
});
