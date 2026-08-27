/**
 * Reentrant ownership: caller code can revoke the ownership it was just granted.
 *
 * Checking ownership BEFORE calling application code is necessary but not
 * sufficient. `hasMore()` is arbitrary synchronous application code — it may
 * legally call `scroll.dispose()` or reassign `sentinelRef.current` and then
 * return `true`. Signal setters are the same hazard by a different route: this
 * framework drains subscribers synchronously, so `setLoading()` runs effects
 * inline, and one of those effects can dispose the controller.
 *
 * So the rule is not "check, then run". It is:
 *
 *   > Passing an ownership check before calling application code does not grant
 *   > permanent ownership. Application code may revoke it synchronously, so
 *   > ownership must be checked again afterward.
 *
 * Two concrete failures motivated this suite. A predicate that disposed and
 * returned `true` left a torn-down controller stuck `loading()`. And a
 * predicate that disposed during the COMPLETION path nulled `observer` between
 * the null-check and the call, producing a `TypeError` inside `finally` — which,
 * because the observer starts loads as `void loadMore()`, surfaced as an
 * unhandled rejection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { effect } from "../src/core/signals/effect";
import { infiniteScroll } from "../src/ui/infiniteScroll";

type ObserverCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly callback: ObserverCallback;
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
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Drain microtasks deterministically — no timers, no arbitrary delay. */
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

const originalIO = globalThis.IntersectionObserver;
const el = (id: string) => {
  const node = document.createElement("div");
  node.id = id;
  return node;
};

/** Collects unhandled rejections for the duration of one test. */
function watchUnhandled() {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  return {
    seen,
    stop: () => process.off("unhandledRejection", onUnhandled),
  };
}

beforeEach(() => {
  FakeObserver.instances = [];
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeObserver;
});

afterEach(() => {
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = originalIO;
  setRuntimeErrorHandler(null);
  vi.restoreAllMocks();
});

describe("1 · initial predicate disposes the controller", () => {
  it("does not start a load, and leaves the controller settled", async () => {
    const watcher = watchUnhandled();
    const errorHandler = vi.fn();
    setRuntimeErrorHandler(errorHandler);
    const onLoadMore = vi.fn(async () => {});

    let scroll!: ReturnType<typeof infiniteScroll>;
    scroll = infiniteScroll({
      onLoadMore,
      hasMore: () => {
        // Arbitrary application work — entirely legal — that revokes ownership
        // and then says "yes, load more".
        scroll.dispose();
        return true;
      },
    });

    const sentinel = el("A");
    scroll.sentinelRef.current = sentinel;
    const observerA = FakeObserver.instances[0];
    const observesBefore = observerA.observeCalls.length;

    expect(() => observerA.fire()).not.toThrow();
    await tick();
    watcher.stop();

    expect(onLoadMore, "a disposed controller started a load").not.toHaveBeenCalled();
    expect(scroll.loading(), "a disposed controller was left loading").toBe(false);
    expect(observerA.observeCalls.length).toBe(observesBefore);
    expect(observerA.unobserveCalls).toHaveLength(0);
    expect(errorHandler).not.toHaveBeenCalled();
    expect(watcher.seen).toEqual([]);
  });
});

describe("2 · initial predicate replaces the sentinel", () => {
  it("the authorizing observer does not start a load, and B still works", async () => {
    setRuntimeErrorHandler(vi.fn());
    const onLoadMore = vi.fn(async () => {});
    const sentinelB = el("B");

    let scroll!: ReturnType<typeof infiniteScroll>;
    let swapped = false;
    scroll = infiniteScroll({
      onLoadMore,
      hasMore: () => {
        // Swap exactly once so the later B assertions are deterministic.
        if (!swapped) {
          swapped = true;
          scroll.sentinelRef.current = sentinelB;
        }
        return true;
      },
    });

    scroll.sentinelRef.current = el("A");
    const observerA = FakeObserver.instances[0];

    observerA.fire();
    await tick();

    const observerB = FakeObserver.instances[1];
    expect(observerB).toBeDefined();
    expect(onLoadMore, "the superseded observer started a load").not.toHaveBeenCalled();
    expect(observerB.unobserveCalls, "observer A touched sentinel B").toHaveLength(0);
    expect(observerB.observeCalls).toEqual([sentinelB]);

    // The current attachment is fully functional.
    observerB.fire();
    await tick();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    scroll.dispose();
  });
});

describe("3 · post-load predicate disposes the controller", () => {
  it("never rejects, never touches a dead observer, and reports no TypeError", async () => {
    const watcher = watchUnhandled();
    const errorHandler = vi.fn();
    setRuntimeErrorHandler(errorHandler);

    let calls = 0;
    let scroll!: ReturnType<typeof infiniteScroll>;
    scroll = infiniteScroll({
      onLoadMore: async () => {},
      hasMore: () => {
        calls++;
        // First call authorizes the load; the second runs in the completion
        // path and revokes ownership from underneath it.
        if (calls === 2) scroll.dispose();
        return true;
      },
    });

    const sentinel = el("A");
    scroll.sentinelRef.current = sentinel;
    const observerA = FakeObserver.instances[0];

    observerA.fire();
    await tick();
    watcher.stop();

    expect(watcher.seen, "loadMore() rejected into the void").toEqual([]);
    expect(observerA.unobserveCalls, "unobserved after disposal").toHaveLength(0);
    expect(observerA.observeCalls, "re-observed after disposal").toEqual([sentinel]);
    expect(scroll.loading()).toBe(false);

    const typeErrors = errorHandler.mock.calls.filter((c) => c[0] instanceof TypeError);
    expect(typeErrors, "an internal TypeError reached the error pipeline").toEqual([]);
  });
});

describe("4 · post-load predicate replaces the sentinel", () => {
  it("the finished load leaves the new attachment untouched", async () => {
    setRuntimeErrorHandler(vi.fn());
    const sentinelA = el("A");
    const sentinelB = el("B");
    const onLoadMore = vi.fn(async () => {});

    let calls = 0;
    let scroll!: ReturnType<typeof infiniteScroll>;
    scroll = infiniteScroll({
      onLoadMore,
      hasMore: () => {
        calls++;
        if (calls === 2) scroll.sentinelRef.current = sentinelB;
        return true;
      },
    });

    scroll.sentinelRef.current = sentinelA;
    const observerA = FakeObserver.instances[0];

    observerA.fire();
    await tick();

    const observerB = FakeObserver.instances[1];
    expect(observerB).toBeDefined();

    expect(observerB.unobserveCalls, "the old load unobserved the new sentinel").toHaveLength(0);
    expect(observerB.observeCalls, "the old load re-observed the new sentinel").toEqual([sentinelB]);
    expect(observerA.disconnectCalls).toBeGreaterThan(0);
    expect(observerA.observeCalls).toEqual([sentinelA]);

    // B is fully operational.
    observerB.fire();
    await tick();
    expect(onLoadMore).toHaveBeenCalledTimes(2);
    scroll.dispose();
  });
});

describe("5 · setLoading(true) revokes ownership synchronously", () => {
  it("does not invoke onLoadMore() when a loading subscriber disposes", async () => {
    const watcher = watchUnhandled();
    setRuntimeErrorHandler(vi.fn());
    const onLoadMore = vi.fn(async () => {});

    let scroll!: ReturnType<typeof infiniteScroll>;
    scroll = infiniteScroll({ onLoadMore, hasMore: () => true });
    scroll.sentinelRef.current = el("A");
    const observerA = FakeObserver.instances[0];

    // This framework drains subscribers synchronously, so this effect runs
    // INSIDE setLoading(true).
    effect(() => {
      if (scroll.loading()) scroll.dispose();
    });

    observerA.fire();
    await tick();
    watcher.stop();

    expect(onLoadMore, "onLoadMore ran after a subscriber revoked ownership").not.toHaveBeenCalled();
    expect(scroll.loading()).toBe(false);
    expect(watcher.seen).toEqual([]);
  });

  it("does not invoke onLoadMore() when a loading subscriber swaps the sentinel", async () => {
    setRuntimeErrorHandler(vi.fn());
    const onLoadMore = vi.fn(async () => {});
    const sentinelB = el("B");

    let scroll!: ReturnType<typeof infiniteScroll>;
    scroll = infiniteScroll({ onLoadMore, hasMore: () => true });
    scroll.sentinelRef.current = el("A");
    const observerA = FakeObserver.instances[0];

    let swapped = false;
    effect(() => {
      if (scroll.loading() && !swapped) {
        swapped = true;
        scroll.sentinelRef.current = sentinelB;
      }
    });

    observerA.fire();
    await tick();

    expect(onLoadMore).not.toHaveBeenCalled();
    scroll.dispose();
  });
});

describe("6 · setLoading(false) revokes ownership synchronously", () => {
  it("does not evaluate the predicate or touch the observer afterwards", async () => {
    const watcher = watchUnhandled();
    setRuntimeErrorHandler(vi.fn());
    const gate = deferred();

    const hasMore = vi.fn(() => true);
    let scroll!: ReturnType<typeof infiniteScroll>;
    scroll = infiniteScroll({ onLoadMore: () => gate.promise, hasMore });

    const sentinel = el("A");
    scroll.sentinelRef.current = sentinel;
    const observerA = FakeObserver.instances[0];

    observerA.fire();
    await tick();
    expect(scroll.loading()).toBe(true);
    const predicateCallsBeforeCompletion = hasMore.mock.calls.length;

    // Fires when the completion path publishes loading=false.
    let disposedOnClear = false;
    effect(() => {
      if (!scroll.loading() && !disposedOnClear) {
        disposedOnClear = true;
        scroll.dispose();
      }
    });

    gate.resolve();
    await tick();
    watcher.stop();

    // The completion's own hasMore() must not run once ownership is revoked.
    expect(hasMore.mock.calls.length, "predicate ran after a subscriber revoked ownership").toBe(
      predicateCallsBeforeCompletion,
    );
    expect(observerA.unobserveCalls).toHaveLength(0);
    expect(observerA.observeCalls).toEqual([sentinel]);
    expect(scroll.loading()).toBe(false);
    expect(watcher.seen).toEqual([]);
  });
});

describe("7 · same-element reassignment keeps the attachment", () => {
  it("does not revoke an in-flight load's ownership", async () => {
    setRuntimeErrorHandler(vi.fn());
    const gate = deferred();
    const sentinel = el("A");

    const scroll = infiniteScroll({ onLoadMore: () => gate.promise, hasMore: () => true });
    scroll.sentinelRef.current = sentinel;
    const observerA = FakeObserver.instances[0];

    observerA.fire();
    await tick();
    expect(scroll.loading()).toBe(true);

    // Reassigning the SAME element is not a new attachment.
    scroll.sentinelRef.current = sentinel;
    expect(scroll.loading(), "same-element reassignment cleared an in-flight load").toBe(true);

    gate.resolve();
    await tick();

    // The load kept its rights: it settled and re-observed its own sentinel.
    expect(scroll.loading()).toBe(false);
    expect(observerA.unobserveCalls).toEqual([sentinel]);
    expect(observerA.observeCalls).toEqual([sentinel, sentinel]);
    scroll.dispose();
  });
});
