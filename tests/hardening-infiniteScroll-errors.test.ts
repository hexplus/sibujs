/**
 * infiniteScroll error/lifecycle contract.
 *
 * INVARIANT (async ownership): the observer callback fires a floating promise.
 * A rejecting `onLoadMore` must reach the central error pipeline, must NOT
 * escape as an unhandled rejection, and must NOT leave `loading` stuck true.
 * A completion landing after dispose() must not mutate state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { infiniteScroll } from "../src/ui/infiniteScroll";

type ObserverCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

let callbacks: ObserverCallback[] = [];
let observeCount = 0;
let disconnectCount = 0;

class FakeIntersectionObserver {
  constructor(cb: ObserverCallback) {
    callbacks.push(cb);
  }
  observe(): void {
    observeCount++;
  }
  unobserve(): void {}
  disconnect(): void {
    disconnectCount++;
  }
}

function trigger(): void {
  for (const cb of callbacks) cb([{ isIntersecting: true }]);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("infiniteScroll — rejection handling", () => {
  const original = globalThis.IntersectionObserver;

  beforeEach(() => {
    callbacks = [];
    observeCount = 0;
    disconnectCount = 0;
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIntersectionObserver;
  });

  afterEach(() => {
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = original;
    setRuntimeErrorHandler(null);
    vi.restoreAllMocks();
  });

  it("does not emit an unhandled rejection when onLoadMore rejects", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);

    const scroll = infiniteScroll({
      onLoadMore: async () => {
        throw new Error("boom");
      },
      hasMore: () => true,
    });
    scroll.sentinelRef.current = document.createElement("div");

    trigger();
    await flush();
    await flush();

    process.off("unhandledRejection", onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
    scroll.dispose();
  });

  it("reports a rejecting onLoadMore through the central error pipeline", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);

    const scroll = infiniteScroll({
      onLoadMore: async () => {
        throw new Error("boom");
      },
      hasMore: () => true,
    });
    scroll.sentinelRef.current = document.createElement("div");

    trigger();
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    const [err, ctx] = handler.mock.calls[0];
    expect((err as Error).message).toBe("boom");
    expect(ctx.phase).toBe("async");
    scroll.dispose();
  });

  it("resets loading to false after a rejection", async () => {
    setRuntimeErrorHandler(() => {});
    const scroll = infiniteScroll({
      onLoadMore: async () => {
        throw new Error("boom");
      },
      hasMore: () => true,
    });
    scroll.sentinelRef.current = document.createElement("div");

    trigger();
    await flush();

    expect(scroll.loading()).toBe(false);
    scroll.dispose();
  });

  it("does not report twice for one rejection", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);

    const scroll = infiniteScroll({
      onLoadMore: async () => {
        throw new Error("boom");
      },
      hasMore: () => true,
    });
    scroll.sentinelRef.current = document.createElement("div");

    trigger();
    await flush();
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    scroll.dispose();
  });

  it("does not emit an unhandled rejection for a synchronously throwing callback", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    setRuntimeErrorHandler(() => {});

    const scroll = infiniteScroll({
      onLoadMore: (() => {
        throw new Error("sync boom");
      }) as unknown as () => Promise<void>,
      hasMore: () => true,
    });
    scroll.sentinelRef.current = document.createElement("div");

    expect(() => trigger()).not.toThrow();
    await flush();

    process.off("unhandledRejection", onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
    expect(scroll.loading()).toBe(false);
    scroll.dispose();
  });

  it("completes a successful load and clears loading", async () => {
    let loads = 0;
    const scroll = infiniteScroll({
      onLoadMore: async () => {
        loads++;
      },
      hasMore: () => true,
    });
    scroll.sentinelRef.current = document.createElement("div");

    trigger();
    expect(scroll.loading()).toBe(true);
    await flush();

    expect(loads).toBe(1);
    expect(scroll.loading()).toBe(false);
    scroll.dispose();
  });

  it("does not start a second concurrent load while one is in flight", async () => {
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const scroll = infiniteScroll({
      onLoadMore: async () => {
        loads++;
        await gate;
      },
      hasMore: () => true,
    });
    scroll.sentinelRef.current = document.createElement("div");

    trigger();
    trigger();
    trigger();
    expect(loads).toBe(1);

    release();
    await flush();
    scroll.dispose();
  });

  it("does not load when hasMore() is false", async () => {
    let loads = 0;
    const scroll = infiniteScroll({
      onLoadMore: async () => {
        loads++;
      },
      hasMore: () => false,
    });
    scroll.sentinelRef.current = document.createElement("div");

    trigger();
    await flush();

    expect(loads).toBe(0);
    scroll.dispose();
  });

  it("does not mutate loading state when the load completes after dispose", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const scroll = infiniteScroll({
      onLoadMore: async () => {
        await gate;
      },
      hasMore: () => true,
    });
    scroll.sentinelRef.current = document.createElement("div");

    trigger();
    expect(scroll.loading()).toBe(true);

    scroll.dispose();
    // Dispose must settle the loading flag itself rather than leaving the
    // pending completion to write it later.
    expect(scroll.loading()).toBe(false);

    let wrote = false;
    const unsub = setRuntimeErrorHandler(null);
    void unsub;
    release();
    await flush();
    wrote = scroll.loading();

    expect(wrote).toBe(false);
    expect(disconnectCount).toBeGreaterThan(0);
  });

  it("does not re-observe after dispose when a pending load settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const scroll = infiniteScroll({
      onLoadMore: async () => {
        await gate;
      },
      hasMore: () => true,
    });
    scroll.sentinelRef.current = document.createElement("div");
    const observesBefore = observeCount;

    trigger();
    scroll.dispose();
    release();
    await flush();

    expect(observeCount).toBe(observesBefore);
  });
});
