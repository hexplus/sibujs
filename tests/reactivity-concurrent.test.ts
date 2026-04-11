import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signal } from "../src/core/signals/signal";
import { defer, transition } from "../src/reactivity/concurrent";

describe("defer", () => {
  it("seeds with the source value", () => {
    const [count] = signal(42);
    const deferred = defer(count);
    expect(deferred()).toBe(42);
  });

  it("eventually converges to the latest source value", async () => {
    const [count, setCount] = signal(0);
    const deferred = defer(count);
    setCount(1);
    setCount(2);
    setCount(3);
    // Wait for microtask + rAF to flush
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
        else setTimeout(resolve, 20);
      });
    });
    expect(deferred()).toBe(3);
  });
});

describe("transition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pending() starts false", () => {
    const t = transition();
    expect(t.pending()).toBe(false);
  });

  it("runs a sync body after the scheduler fires", () => {
    const t = transition();
    let ran = false;
    t.start(() => {
      ran = true;
    });
    vi.advanceTimersByTime(100);
    // Also flush any rAF scheduled via the scheduler's fallback
    expect(ran).toBe(true);
  });

  it("start() sets pending true, body resets it", () => {
    const t = transition();
    t.start(() => {
      // sync body — pending should flip true then false synchronously after flush
    });
    expect(t.pending()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(t.pending()).toBe(false);
  });

  it("swallows exceptions from the body and resets pending", () => {
    const t = transition();
    t.start(() => {
      throw new Error("boom");
    });
    vi.advanceTimersByTime(100);
    expect(t.pending()).toBe(false);
  });
});
