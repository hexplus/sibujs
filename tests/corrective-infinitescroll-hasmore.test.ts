/**
 * `hasMore()` is caller-controlled code, so it must sit inside the same error
 * containment as `onLoadMore()`.
 *
 * It was evaluated bare in two places. The first — inside the
 * `IntersectionObserver` callback — lets a throw escape into a native callback,
 * where nothing in the application can catch it. The second is worse: the
 * post-load `finally`, where a throw propagates out of `loadMore()` and breaks
 * its documented "never rejects" invariant. Callers invoke it as
 * `void loadMore()`, so that rejection has no handler at all and surfaces as an
 * unhandled rejection — crashing a Node SSR process for what is, at worst, a
 * broken pagination predicate.
 *
 * Containment is not silence: a throwing `hasMore()` is reported through the
 * central pipeline and treated as `false`, which is the answer that stops
 * rather than the answer that loops.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { infiniteScroll } from "../src/ui/infiniteScroll";

type ObserverCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

let callbacks: ObserverCallback[] = [];
let observeCount = 0;
let unobserveCount = 0;

class FakeIntersectionObserver {
  constructor(cb: ObserverCallback) {
    callbacks.push(cb);
  }
  observe(): void {
    observeCount++;
  }
  unobserve(): void {
    unobserveCount++;
  }
  disconnect(): void {}
}

function trigger(): void {
  for (const cb of callbacks) cb([{ isIntersecting: true }]);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const originalIO = globalThis.IntersectionObserver;

beforeEach(() => {
  callbacks = [];
  observeCount = 0;
  unobserveCount = 0;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIntersectionObserver;
});

afterEach(() => {
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = originalIO;
  setRuntimeErrorHandler(null);
  vi.restoreAllMocks();
});

describe("infiniteScroll — hasMore() failures are contained", () => {
  it("reports a throwing hasMore() during the intersection decision and does not load", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);
    const onLoadMore = vi.fn(async () => {});

    const scroll = infiniteScroll({
      onLoadMore,
      hasMore: () => {
        throw new Error("hasMore boom");
      },
    });
    scroll.sentinelRef.current = document.createElement("div");

    // The exception must not escape the native observer callback.
    expect(() => trigger()).not.toThrow();
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    const [err, ctx] = handler.mock.calls[0];
    expect((err as Error).message).toBe("hasMore boom");
    expect(ctx.phase).toBe("async");
    expect(ctx.name).toBe("infiniteScroll(hasMore)");

    // A predicate that cannot answer is treated as "no more", so no load runs.
    expect(onLoadMore).not.toHaveBeenCalled();
    expect(scroll.loading()).toBe(false);
    scroll.dispose();
  });

  it("contains a hasMore() that throws in the post-load re-observe path", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);

    const handler = vi.fn();
    setRuntimeErrorHandler(handler);

    let calls = 0;
    const onLoadMore = vi.fn(async () => {});

    const scroll = infiniteScroll({
      onLoadMore,
      hasMore: () => {
        calls++;
        // First call gates the load; the second happens in `finally`.
        if (calls === 1) return true;
        throw new Error("hasMore boom late");
      },
    });
    scroll.sentinelRef.current = document.createElement("div");
    const observesAfterAttach = observeCount;

    expect(() => trigger()).not.toThrow();
    await flush();
    await flush();

    process.off("unhandledRejection", onUnhandled);

    // The load itself succeeded…
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    // …and the predicate failure was reported, not swallowed.
    const reported = handler.mock.calls.filter((c) => (c[0] as Error)?.message === "hasMore boom late");
    expect(reported).toHaveLength(1);
    expect(reported[0][1].name).toBe("infiniteScroll(hasMore)");

    // loadMore() must keep its "never rejects" invariant.
    expect(onUnhandled, "a rejection escaped loadMore()").not.toHaveBeenCalled();

    // A predicate that threw is `false`, so the sentinel is NOT re-observed.
    expect(observeCount).toBe(observesAfterAttach);
    expect(unobserveCount).toBe(0);

    // State still settles correctly.
    expect(scroll.loading()).toBe(false);
    scroll.dispose();
  });

  it("still re-observes when hasMore() legitimately returns true", async () => {
    setRuntimeErrorHandler(() => {});
    const scroll = infiniteScroll({
      onLoadMore: async () => {},
      hasMore: () => true,
    });
    scroll.sentinelRef.current = document.createElement("div");
    const before = observeCount;

    trigger();
    await flush();

    expect(observeCount).toBe(before + 1);
    expect(unobserveCount).toBe(1);
    scroll.dispose();
  });

  it("does not re-observe when hasMore() legitimately returns false", async () => {
    setRuntimeErrorHandler(() => {});
    let calls = 0;
    const scroll = infiniteScroll({
      onLoadMore: async () => {},
      hasMore: () => {
        calls++;
        return calls === 1;
      },
    });
    scroll.sentinelRef.current = document.createElement("div");
    const before = observeCount;

    trigger();
    await flush();

    expect(observeCount).toBe(before);
    scroll.dispose();
  });

  it("keeps reporting a throwing onLoadMore separately from hasMore", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);

    const scroll = infiniteScroll({
      onLoadMore: async () => {
        throw new Error("load boom");
      },
      hasMore: () => true,
    });
    scroll.sentinelRef.current = document.createElement("div");

    trigger();
    await flush();

    const names = handler.mock.calls.map((c) => c[1].name);
    expect(names).toContain("infiniteScroll(onLoadMore)");
    scroll.dispose();
  });
});
