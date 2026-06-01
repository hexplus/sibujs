import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { defer, transition } from "../src/reactivity/concurrent";

// Flush the microtask + requestAnimationFrame pair that defer() schedules.
function flushDefer(): Promise<void> {
  return new Promise<void>((resolve) => {
    queueMicrotask(() => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 20);
      }
    });
  });
}

describe("defer", () => {
  it("seeds the accessor with the source value immediately", () => {
    const [count] = signal(7);
    const deferred = defer(count);
    expect(deferred()).toBe(7);
  });

  it("returns an accessor function with a dispose method", () => {
    const [count] = signal(0);
    const deferred = defer(count);
    expect(typeof deferred).toBe("function");
    expect(typeof deferred.dispose).toBe("function");
  });

  it("does not reflect a source change until the scheduled flush runs", () => {
    const [count, setCount] = signal(0);
    const deferred = defer(count);
    setCount(5);
    // Synchronously the deferred mirror still holds the seed value.
    expect(deferred()).toBe(0);
  });

  it("converges to the latest source value after flush", async () => {
    const [count, setCount] = signal(0);
    const deferred = defer(count);
    setCount(42);
    await flushDefer();
    expect(deferred()).toBe(42);
  });

  it("coalesces multiple same-frame updates to only the latest value", async () => {
    const [count, setCount] = signal(0);
    const deferred = defer(count);

    let updates = 0;
    effect(() => {
      deferred();
      updates++;
    });
    const initialUpdates = updates;

    setCount(1);
    setCount(2);
    setCount(3);
    await flushDefer();

    expect(deferred()).toBe(3);
    // The mirror signal updated at most once for the burst of source writes.
    expect(updates - initialUpdates).toBeLessThanOrEqual(1);
  });

  it("tracks the source through an effect — deferred value is reactive", async () => {
    const [count, setCount] = signal(0);
    const deferred = defer(count);
    const seen: number[] = [];
    effect(() => {
      seen.push(deferred());
    });
    expect(seen).toEqual([0]);

    setCount(9);
    await flushDefer();
    expect(seen[seen.length - 1]).toBe(9);
  });

  it("dispose() stops further updates from propagating", async () => {
    const [count, setCount] = signal(0);
    const deferred = defer(count);

    deferred.dispose();
    setCount(100);
    await flushDefer();

    // After disposal the tracking teardown ran, so the mirror never updates.
    expect(deferred()).toBe(0);
  });

  it("dispose() is idempotent", () => {
    const [count] = signal(0);
    const deferred = defer(count);
    deferred.dispose();
    expect(() => deferred.dispose()).not.toThrow();
  });

  it("a pending flush after dispose is a no-op", async () => {
    const [count, setCount] = signal(0);
    const deferred = defer(count);

    setCount(3); // schedules a flush
    deferred.dispose(); // dispose before the rAF fires
    await flushDefer();

    expect(deferred()).toBe(0);
  });

  it("works with a derived/computed-style getter", async () => {
    const [a, setA] = signal(1);
    const [b, setB] = signal(2);
    const deferred = defer(() => a() + b());
    expect(deferred()).toBe(3);

    setA(10);
    setB(20);
    await flushDefer();
    expect(deferred()).toBe(30);
  });

  it("falls back to a synchronous flush when requestAnimationFrame is unavailable", async () => {
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    const original = g.requestAnimationFrame;
    g.requestAnimationFrame = undefined;
    try {
      const [count, setCount] = signal(0);
      const deferred = defer(count);
      setCount(55);
      // Only a microtask is needed now (flush runs inline in the microtask).
      await Promise.resolve();
      expect(deferred()).toBe(55);
    } finally {
      g.requestAnimationFrame = original;
    }
  });
});

describe("transition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes pending() and start()", () => {
    const t = transition();
    expect(typeof t.pending).toBe("function");
    expect(typeof t.start).toBe("function");
  });

  it("pending() is false initially", () => {
    const t = transition();
    expect(t.pending()).toBe(false);
  });

  it("does not run the body synchronously", () => {
    const t = transition();
    const fn = vi.fn();
    t.start(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("start() flips pending() to true synchronously", () => {
    const t = transition();
    t.start(() => {});
    expect(t.pending()).toBe(true);
  });

  it("runs the body once the scheduler fires", () => {
    const t = transition();
    const fn = vi.fn();
    t.start(fn);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resets pending() to false after a sync body completes", () => {
    const t = transition();
    t.start(() => {});
    expect(t.pending()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(t.pending()).toBe(false);
  });

  it("applies state updates made inside the body", () => {
    const t = transition();
    const [value, setValue] = signal("before");
    t.start(() => setValue("after"));
    expect(value()).toBe("before");
    vi.advanceTimersByTime(100);
    expect(value()).toBe("after");
  });

  it("swallows synchronous exceptions and resets pending()", () => {
    const t = transition();
    t.start(() => {
      throw new Error("boom");
    });
    vi.advanceTimersByTime(100);
    expect(t.pending()).toBe(false);
  });

  it("keeps pending() true until an async body resolves", async () => {
    const t = transition();
    let resolveFn!: () => void;
    const p = new Promise<void>((res) => {
      resolveFn = res;
    });
    t.start(() => p);

    expect(t.pending()).toBe(true);
    vi.advanceTimersByTime(100);
    // Body has run and returned a still-pending promise.
    expect(t.pending()).toBe(true);

    resolveFn();
    await p;
    await Promise.resolve();
    expect(t.pending()).toBe(false);
  });

  it("resets pending() when an async body rejects", async () => {
    const t = transition();
    let rejectFn!: (e: unknown) => void;
    const p = new Promise<void>((_res, rej) => {
      rejectFn = rej;
    });
    t.start(() => p);

    vi.advanceTimersByTime(100);
    expect(t.pending()).toBe(true);

    rejectFn(new Error("nope"));
    await p.catch(() => {});
    await Promise.resolve();
    expect(t.pending()).toBe(false);
  });

  it("pending() is reactive — effects re-run as it toggles", () => {
    const t = transition();
    const states: boolean[] = [];
    effect(() => {
      states.push(t.pending());
    });
    expect(states).toEqual([false]);

    t.start(() => {});
    // start() set pending true synchronously.
    expect(states[states.length - 1]).toBe(true);

    vi.advanceTimersByTime(100);
    expect(states[states.length - 1]).toBe(false);
  });

  it("supports multiple sequential transitions", () => {
    const t = transition();
    const [value, setValue] = signal(0);

    t.start(() => setValue(1));
    vi.advanceTimersByTime(100);
    expect(value()).toBe(1);
    expect(t.pending()).toBe(false);

    t.start(() => setValue(2));
    vi.advanceTimersByTime(100);
    expect(value()).toBe(2);
    expect(t.pending()).toBe(false);
  });

  it("uses requestIdleCallback when available", () => {
    const g = globalThis as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
    };
    const original = g.requestIdleCallback;
    const ric = vi.fn((cb: () => void) => {
      cb();
      return 1;
    });
    g.requestIdleCallback = ric as unknown as typeof g.requestIdleCallback;
    try {
      const t = transition();
      const fn = vi.fn();
      t.start(fn);
      expect(ric).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(t.pending()).toBe(false);
    } finally {
      g.requestIdleCallback = original;
    }
  });
});
