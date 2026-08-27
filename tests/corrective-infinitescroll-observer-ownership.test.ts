/**
 * Stale `IntersectionObserver` callbacks and superseded sentinel attachments.
 *
 * `disconnect()` stops FUTURE notifications; it does not un-queue a callback
 * the engine has already scheduled. So a controller can be disposed, or its
 * sentinel swapped, while a callback is still in flight — and that callback
 * closes over the controller, not over the attachment it belonged to.
 *
 * Two ownership holes followed:
 *
 *   1. `safeHasMore()` was evaluated BEFORE the `disposed` check, so a queued
 *      callback ran caller-controlled code (and could report predicate errors)
 *      after teardown.
 *   2. The callback compared nothing about WHICH observer it came from, and the
 *      sentinel setter never advanced the ownership generation. A callback
 *      queued against sentinel A could therefore start a load that later
 *      published state for, and re-observed, sentinel B.
 *
 * The fake observer below deliberately keeps every instance separate and fires
 * them individually. A helper that fires "all callbacks" would hide exactly the
 * identity bug these tests exist to catch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { infiniteScroll } from "../src/ui/infiniteScroll";

type ObserverCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly callback: ObserverCallback;
  /** Captured so threshold forwarding can be asserted, not merely counted. */
  readonly options: IntersectionObserverInit | undefined;
  observeCalls: Element[] = [];
  unobserveCalls: Element[] = [];
  disconnectCalls = 0;

  constructor(cb: ObserverCallback, options?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = options;
    FakeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observeCalls.push(el);
  }
  unobserve(el: Element): void {
    this.unobserveCalls.push(el);
  }
  disconnect(): void {
    this.disconnectCalls++;
  }
  /** Deliver an intersection to THIS observer only. */
  fire(isIntersecting = true): void {
    this.callback([{ isIntersecting }]);
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Attached at creation so a rejection a test arranges cannot escape while the
  // test is still setting up.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Drain microtasks without introducing a timing dependency. */
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const originalIO = globalThis.IntersectionObserver;

beforeEach(() => {
  FakeObserver.instances = [];
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
});

afterEach(() => {
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = originalIO;
  setRuntimeErrorHandler(null);
  vi.restoreAllMocks();
});

const el = (id: string) => {
  const node = document.createElement("div");
  node.id = id;
  return node;
};

describe("1 · a callback queued before dispose() runs no caller code", () => {
  it("does not evaluate hasMore(), start a load, or report after teardown", async () => {
    const hasMore = vi.fn(() => true);
    const onLoadMore = vi.fn(async () => {});
    const errorHandler = vi.fn();
    setRuntimeErrorHandler(errorHandler);

    const scroll = infiniteScroll({ onLoadMore, hasMore });
    scroll.sentinelRef.current = el("A");

    const observerA = FakeObserver.instances[0];
    expect(observerA).toBeDefined();
    const observesBefore = observerA.observeCalls.length;

    scroll.dispose();

    // The engine had already scheduled this callback.
    expect(() => observerA.fire()).not.toThrow();
    await tick();

    expect(hasMore, "caller predicate ran after disposal").not.toHaveBeenCalled();
    expect(onLoadMore).not.toHaveBeenCalled();
    expect(errorHandler).not.toHaveBeenCalled();
    expect(scroll.loading()).toBe(false);
    expect(observerA.observeCalls.length).toBe(observesBefore);
  });

  it("does not report a throwing hasMore() from a post-dispose callback", async () => {
    const errorHandler = vi.fn();
    setRuntimeErrorHandler(errorHandler);
    const hasMore = vi.fn(() => {
      throw new Error("should never run");
    });

    const scroll = infiniteScroll({ onLoadMore: async () => {}, hasMore });
    scroll.sentinelRef.current = el("A");
    const observerA = FakeObserver.instances[0];

    scroll.dispose();
    expect(() => observerA.fire()).not.toThrow();
    await tick();

    expect(hasMore).not.toHaveBeenCalled();
    expect(errorHandler, "a disposed controller reported a stale predicate error").not.toHaveBeenCalled();
  });
});

describe("2 · a callback from a replaced observer is inert", () => {
  it("the stale observer touches no caller code and no newer observer", async () => {
    const hasMore = vi.fn(() => true);
    const onLoadMore = vi.fn(async () => {});
    setRuntimeErrorHandler(vi.fn());

    const scroll = infiniteScroll({ onLoadMore, hasMore });

    scroll.sentinelRef.current = el("A");
    const observerA = FakeObserver.instances[0];

    const sentinelB = el("B");
    scroll.sentinelRef.current = sentinelB;
    const observerB = FakeObserver.instances[1];
    expect(observerB).toBeDefined();
    expect(observerB).not.toBe(observerA);

    const bObservesBefore = observerB.observeCalls.length;

    // Callback queued against A arrives after B took over.
    expect(() => observerA.fire()).not.toThrow();
    await tick();

    expect(hasMore, "a replaced observer evaluated the caller predicate").not.toHaveBeenCalled();
    expect(onLoadMore).not.toHaveBeenCalled();
    expect(scroll.loading()).toBe(false);
    expect(observerB.observeCalls.length, "the stale callback re-observed the newer sentinel").toBe(bObservesBefore);
    expect(observerB.unobserveCalls).toHaveLength(0);
  });

  it("the current observer still loads normally afterwards", async () => {
    const hasMore = vi.fn(() => true);
    const onLoadMore = vi.fn(async () => {});
    setRuntimeErrorHandler(vi.fn());

    const scroll = infiniteScroll({ onLoadMore, hasMore });
    scroll.sentinelRef.current = el("A");
    const observerA = FakeObserver.instances[0];
    scroll.sentinelRef.current = el("B");
    const observerB = FakeObserver.instances[1];

    observerA.fire();
    await tick();
    expect(onLoadMore).not.toHaveBeenCalled();

    observerB.fire();
    await tick();

    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(hasMore).toHaveBeenCalled();
    scroll.dispose();
  });
});

describe("3 · a load belonging to the old sentinel cannot act on the new one", () => {
  it("does not observe, unobserve, or restart pagination for B", async () => {
    const gate = deferred();
    const hasMore = vi.fn(() => true);
    setRuntimeErrorHandler(vi.fn());

    const scroll = infiniteScroll({
      onLoadMore: () => gate.promise,
      hasMore,
    });

    scroll.sentinelRef.current = el("A");
    const observerA = FakeObserver.instances[0];

    observerA.fire();
    await tick();
    expect(scroll.loading()).toBe(true);

    // Swap the sentinel while load A is still in flight.
    const sentinelB = el("B");
    scroll.sentinelRef.current = sentinelB;
    const observerB = FakeObserver.instances[1];
    const bObservesAfterAttach = observerB.observeCalls.length;

    // Load A settles late.
    gate.resolve();
    await tick();

    expect(observerB.unobserveCalls, "stale load unobserved the new sentinel").toHaveLength(0);
    expect(observerB.observeCalls.length, "stale load re-observed the new sentinel").toBe(bObservesAfterAttach);
    expect(observerA.observeCalls.length, "stale load re-armed its own dead observer").toBe(1);

    // And loading is not wedged: the new attachment is free to load.
    expect(scroll.loading()).toBe(false);
    scroll.dispose();
  });

  it("lets the new sentinel start its own load after the swap", async () => {
    const gateA = deferred();
    const onLoadMore = vi.fn(() => gateA.promise);
    setRuntimeErrorHandler(vi.fn());

    const scroll = infiniteScroll({ onLoadMore, hasMore: () => true });
    scroll.sentinelRef.current = el("A");
    FakeObserver.instances[0].fire();
    await tick();

    scroll.sentinelRef.current = el("B");
    const observerB = FakeObserver.instances[1];

    // B must not be blocked by A's in-flight load.
    observerB.fire();
    await tick();

    expect(onLoadMore).toHaveBeenCalledTimes(2);
    expect(scroll.loading()).toBe(true);
    gateA.resolve();
    scroll.dispose();
  });
});

describe("4 · overlapping loads across a sentinel change", () => {
  it("A settling first cannot clear B's loading state or re-observe B", async () => {
    const gateA = deferred();
    const gateB = deferred();
    let call = 0;
    const hasMore = vi.fn(() => true);
    setRuntimeErrorHandler(vi.fn());

    const scroll = infiniteScroll({
      onLoadMore: () => {
        call++;
        return call === 1 ? gateA.promise : gateB.promise;
      },
      hasMore,
    });

    scroll.sentinelRef.current = el("A");
    FakeObserver.instances[0].fire();
    await tick();

    const sentinelB = el("B");
    scroll.sentinelRef.current = sentinelB;
    const observerB = FakeObserver.instances[1];

    observerB.fire();
    await tick();
    expect(scroll.loading()).toBe(true);
    const bObservesBeforeSettle = observerB.observeCalls.length;

    // A settles while B is still pending.
    gateA.resolve();
    await tick();

    expect(scroll.loading(), "a superseded load cleared the current load's state").toBe(true);
    expect(observerB.unobserveCalls, "a superseded load unobserved the current sentinel").toHaveLength(0);
    expect(observerB.observeCalls.length).toBe(bObservesBeforeSettle);

    // B settles: it owns the state, so it clears loading and may re-observe.
    gateB.resolve();
    await tick();

    expect(scroll.loading()).toBe(false);
    expect(observerB.unobserveCalls).toHaveLength(1);
    expect(observerB.observeCalls.length).toBe(bObservesBeforeSettle + 1);
    scroll.dispose();
  });

  it("B settling first still leaves A unable to publish", async () => {
    const gateA = deferred();
    const gateB = deferred();
    let call = 0;
    setRuntimeErrorHandler(vi.fn());

    const scroll = infiniteScroll({
      onLoadMore: () => {
        call++;
        return call === 1 ? gateA.promise : gateB.promise;
      },
      hasMore: () => true,
    });

    scroll.sentinelRef.current = el("A");
    FakeObserver.instances[0].fire();
    await tick();

    scroll.sentinelRef.current = el("B");
    const observerB = FakeObserver.instances[1];
    observerB.fire();
    await tick();

    gateB.resolve();
    await tick();
    expect(scroll.loading()).toBe(false);
    const observesAfterB = observerB.observeCalls.length;
    const unobservesAfterB = observerB.unobserveCalls.length;

    // A settles last and must change nothing.
    gateA.resolve();
    await tick();

    expect(scroll.loading()).toBe(false);
    expect(observerB.observeCalls.length).toBe(observesAfterB);
    expect(observerB.unobserveCalls.length).toBe(unobservesAfterB);
    scroll.dispose();
  });
});

describe("5 · existing behaviour is preserved", () => {
  it("the current observer starts exactly one load", async () => {
    const onLoadMore = vi.fn(async () => {});
    setRuntimeErrorHandler(vi.fn());
    const scroll = infiniteScroll({ onLoadMore, hasMore: () => true });
    scroll.sentinelRef.current = el("A");

    FakeObserver.instances[0].fire();
    await tick();

    expect(onLoadMore).toHaveBeenCalledTimes(1);
    scroll.dispose();
  });

  it("concurrent intersections do not start duplicate loads", async () => {
    const gate = deferred();
    const onLoadMore = vi.fn(() => gate.promise);
    setRuntimeErrorHandler(vi.fn());
    const scroll = infiniteScroll({ onLoadMore, hasMore: () => true });
    scroll.sentinelRef.current = el("A");
    const observerA = FakeObserver.instances[0];

    observerA.fire();
    observerA.fire();
    observerA.fire();
    await tick();

    expect(onLoadMore).toHaveBeenCalledTimes(1);
    gate.resolve();
    await tick();
    scroll.dispose();
  });

  it("re-observes the current sentinel when hasMore() stays true", async () => {
    setRuntimeErrorHandler(vi.fn());
    const scroll = infiniteScroll({ onLoadMore: async () => {}, hasMore: () => true });
    const sentinel = el("A");
    scroll.sentinelRef.current = sentinel;
    const observerA = FakeObserver.instances[0];

    observerA.fire();
    await tick();

    expect(observerA.unobserveCalls).toEqual([sentinel]);
    expect(observerA.observeCalls).toEqual([sentinel, sentinel]);
    scroll.dispose();
  });

  it("does not re-observe when hasMore() returns false", async () => {
    let calls = 0;
    setRuntimeErrorHandler(vi.fn());
    const scroll = infiniteScroll({
      onLoadMore: async () => {},
      hasMore: () => {
        calls++;
        return calls === 1;
      },
    });
    scroll.sentinelRef.current = el("A");
    const observerA = FakeObserver.instances[0];

    observerA.fire();
    await tick();

    expect(observerA.unobserveCalls).toHaveLength(0);
    expect(observerA.observeCalls).toHaveLength(1);
    scroll.dispose();
  });

  it("keeps a throwing hasMore() contained with no unhandled rejection", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    const errorHandler = vi.fn();
    setRuntimeErrorHandler(errorHandler);

    const scroll = infiniteScroll({
      onLoadMore: async () => {},
      hasMore: () => {
        throw new Error("predicate boom");
      },
    });
    scroll.sentinelRef.current = el("A");

    expect(() => FakeObserver.instances[0].fire()).not.toThrow();
    await tick();
    process.off("unhandledRejection", onUnhandled);

    expect(onUnhandled).not.toHaveBeenCalled();
    const reported = errorHandler.mock.calls.filter((c) => c[1]?.name === "infiniteScroll(hasMore)");
    expect(reported).toHaveLength(1);
    expect(scroll.loading()).toBe(false);
    scroll.dispose();
  });

  it("disposal during a pending load stays safe", async () => {
    const gate = deferred();
    setRuntimeErrorHandler(vi.fn());
    const scroll = infiniteScroll({ onLoadMore: () => gate.promise, hasMore: () => true });
    scroll.sentinelRef.current = el("A");
    const observerA = FakeObserver.instances[0];

    observerA.fire();
    await tick();
    expect(scroll.loading()).toBe(true);

    scroll.dispose();
    expect(scroll.loading()).toBe(false);

    gate.resolve();
    await tick();

    expect(scroll.loading()).toBe(false);
    expect(observerA.observeCalls).toHaveLength(1);
  });

  it("is inert when IntersectionObserver is unavailable", () => {
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = undefined;
    const onLoadMore = vi.fn(async () => {});
    const scroll = infiniteScroll({ onLoadMore, hasMore: () => true });

    expect(() => {
      scroll.sentinelRef.current = el("A");
    }).not.toThrow();
    expect(onLoadMore).not.toHaveBeenCalled();
    expect(() => scroll.dispose()).not.toThrow();
  });

  it("forwards the configured threshold to every observer it creates", () => {
    setRuntimeErrorHandler(vi.fn());
    const scroll = infiniteScroll({ onLoadMore: async () => {}, hasMore: () => true, threshold: 0.75 });

    scroll.sentinelRef.current = el("A");
    scroll.sentinelRef.current = el("B");

    const [observerA, observerB] = FakeObserver.instances;
    expect(observerA).toBeDefined();
    expect(observerB).toBeDefined();

    // Counting instances proved nothing about the option actually reaching the
    // constructor; assert the value each observer was built with.
    expect(observerA.options?.threshold).toBe(0.75);
    expect(observerB.options?.threshold).toBe(0.75);
    scroll.dispose();
  });

  it("defaults the threshold to 0 when none is configured", () => {
    setRuntimeErrorHandler(vi.fn());
    const scroll = infiniteScroll({ onLoadMore: async () => {}, hasMore: () => true });
    scroll.sentinelRef.current = el("A");

    expect(FakeObserver.instances[0].options?.threshold).toBe(0);
    scroll.dispose();
  });

  it("treats a same-element reassignment as the same attachment", () => {
    setRuntimeErrorHandler(vi.fn());
    const scroll = infiniteScroll({ onLoadMore: async () => {}, hasMore: () => true });
    const sentinel = el("A");

    scroll.sentinelRef.current = sentinel;
    const observerA = FakeObserver.instances[0];

    scroll.sentinelRef.current = sentinel;

    // No new observer, and the existing one is left connected: the attachment
    // never changed, so there is nothing to invalidate.
    expect(FakeObserver.instances).toHaveLength(1);
    expect(observerA.disconnectCalls).toBe(0);
    expect(observerA.observeCalls).toEqual([sentinel]);
    scroll.dispose();
  });
});
