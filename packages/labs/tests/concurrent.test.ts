import { signal } from "@sibujs/core";
import { describe, expect, it, vi } from "vitest";
import {
  deferredValue,
  resetIdCounter,
  setIdPrefix,
  startTransition,
  transitionState,
  uniqueId,
} from "../src/performance/concurrent";
import { flushScheduler } from "../src/performance/scheduler";

// ============================================================================
// startTransition
// ============================================================================

describe("startTransition", () => {
  it("should schedule a callback at normal priority (not synchronous)", () => {
    const fn = vi.fn();
    startTransition(fn);

    // The callback should NOT execute synchronously
    expect(fn).not.toHaveBeenCalled();

    // After flushing the scheduler, it should have run
    flushScheduler();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("should execute multiple transitions in order when flushed", () => {
    const order: number[] = [];

    startTransition(() => order.push(1));
    startTransition(() => order.push(2));
    startTransition(() => order.push(3));

    flushScheduler();
    expect(order).toEqual([1, 2, 3]);
  });

  it("should allow state updates inside the callback", () => {
    const [count, setCount] = signal(0);

    startTransition(() => {
      setCount(42);
    });

    // Before flush, state should be unchanged
    expect(count()).toBe(0);

    flushScheduler();
    expect(count()).toBe(42);
  });
});

// ============================================================================
// deferredValue
// ============================================================================

describe("deferredValue", () => {
  it("should return the initial value immediately", () => {
    const [value] = signal("hello");
    const deferred = deferredValue(value);

    // The deferred getter should return the initial value
    expect(deferred()).toBe("hello");
  });

  it("should eventually reflect source changes after flushing", () => {
    const [value, setValue] = signal("initial");
    const deferred = deferredValue(value);

    // Flush initial LOW-priority sync
    flushScheduler();
    expect(deferred()).toBe("initial");

    // Update the source value
    setValue("updated");

    // The deferred value has not caught up yet (low priority not flushed)
    // Read the deferred value to enqueue a sync
    const _snapshot = deferred();

    // Flush the scheduler so the LOW-priority sync runs
    flushScheduler();

    // Now reading the deferred value should reflect the update
    expect(deferred()).toBe("updated");
  });

  it("should return a function (getter)", () => {
    const [value] = signal(10);
    const deferred = deferredValue(value);

    expect(typeof deferred).toBe("function");
  });

  it("should expose a dispose function on the getter", () => {
    const [value] = signal(10);
    const deferred = deferredValue(value);

    expect(typeof deferred.dispose).toBe("function");
    // dispose is non-enumerable so the getter's public shape stays clean
    expect(Object.keys(deferred)).not.toContain("dispose");
  });

  it("dispose() tears down the source subscription (no leak)", () => {
    const [value, setValue] = signal("a");
    const deferred = deferredValue(value);

    flushScheduler();
    expect(deferred()).toBe("a");

    // Before dispose, source changes propagate after a flush.
    setValue("b");
    flushScheduler();
    expect(deferred()).toBe("b");

    // After dispose, the internal effect is gone: source changes no longer
    // schedule updates, so the deferred value stays frozen.
    deferred.dispose();
    setValue("c");
    flushScheduler();
    expect(deferred()).toBe("b");
  });
});

// ============================================================================
// transitionState
// ============================================================================

describe("transitionState", () => {
  it("should return a tuple of [isPending, startTransition]", () => {
    const [isPending, start] = transitionState();

    expect(typeof isPending).toBe("function");
    expect(typeof start).toBe("function");
  });

  it("should have isPending as false initially", () => {
    const [isPending] = transitionState();
    expect(isPending()).toBe(false);
  });

  it("should set isPending to true synchronously when a transition starts", () => {
    const [isPending, start] = transitionState();

    start(() => {
      // no-op transition
    });

    // isPending should be true immediately after starting a transition
    expect(isPending()).toBe(true);
  });

  it("should set isPending back to false after the transition flushes", () => {
    const [isPending, start] = transitionState();

    start(() => {
      // no-op
    });

    expect(isPending()).toBe(true);

    // Flush: runs the callback, then schedules the isPending(false) update
    flushScheduler();

    expect(isPending()).toBe(false);
  });

  it("should execute the transition callback when flushed", () => {
    const [, start] = transitionState();
    const [value, setValue] = signal("before");

    start(() => {
      setValue("after");
    });

    // The callback has not run yet (NORMAL priority)
    expect(value()).toBe("before");

    flushScheduler();
    expect(value()).toBe("after");
  });

  it("should support multiple sequential transitions", () => {
    const [isPending, start] = transitionState();
    const [value, setValue] = signal(0);

    // First transition
    start(() => setValue(1));
    expect(isPending()).toBe(true);

    flushScheduler();
    expect(value()).toBe(1);
    expect(isPending()).toBe(false);

    // Second transition
    start(() => setValue(2));
    expect(isPending()).toBe(true);

    flushScheduler();
    expect(value()).toBe(2);
    expect(isPending()).toBe(false);
  });
});

// ============================================================================
// id
// ============================================================================

describe("id", () => {
  beforeEach(() => {
    resetIdCounter();
    setIdPrefix("sibu");
  });

  it("should generate sequential unique IDs", () => {
    const id1 = uniqueId();
    const id2 = uniqueId();
    const id3 = uniqueId();

    expect(id1).toBe("sibu-0");
    expect(id2).toBe("sibu-1");
    expect(id3).toBe("sibu-2");
  });

  it("should append suffix when provided", () => {
    const uid = uniqueId("label");
    expect(uid).toBe("sibu-0-label");
  });

  it("should reset counter with resetIdCounter", () => {
    uniqueId();
    uniqueId();
    resetIdCounter();
    const uid = uniqueId();
    expect(uid).toBe("sibu-0");
  });

  it("should use custom prefix from setIdPrefix", () => {
    setIdPrefix("myapp");
    const uid = uniqueId();
    expect(uid).toBe("myapp-0");
  });

  it("should produce deterministic IDs across resets (SSR parity)", () => {
    resetIdCounter();
    const serverIds = [uniqueId(), uniqueId(), uniqueId()];

    resetIdCounter();
    const clientIds = [uniqueId(), uniqueId(), uniqueId()];

    expect(serverIds).toEqual(clientIds);
  });
});
