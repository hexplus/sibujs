import { afterEach, describe, expect, it, vi } from "vitest";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { createSSRCache, deferNonCritical, prerenderRoutes } from "../src/plugins/startup";

// ---------------------------------------------------------------------------
// Startup caches respect their size bounds, and deferNonCritical() always makes
// progress.
//
// THE DEFECTS:
// 1. Eviction ran before checking whether the key already existed, so
//    overwriting a key at capacity evicted an unrelated entry; `maxSize: 0`
//    still stored one item; an oldest key of "" was never evicted
//    (`if (oldestKey)`); and valid entries were evicted while expired ones stayed.
// 2. deferNonCritical() passed no timeout to requestIdleCallback and, given a
//    deadline with under 1ms left, rescheduled without running a single task —
//    so on a busy page deferred work could starve forever.
// ---------------------------------------------------------------------------

afterEach(() => {
  setRuntimeErrorHandler(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const el = (text: string) => () => {
  const d = document.createElement("div");
  d.textContent = text;
  return d;
};

describe("createSSRCache bounds", () => {
  it("overwriting a key at capacity keeps every other entry", () => {
    const cache = createSSRCache({ maxSize: 2 });
    cache.set("a", "A");
    cache.set("b", "B");
    cache.set("b", "B2");

    expect(cache.has("a")).toBe(true);
    expect(cache.get("b")).toBe("B2");
    expect(cache.stats().size).toBe(2);
  });

  it("maxSize: 0 disables caching", () => {
    const cache = createSSRCache({ maxSize: 0 });
    cache.set("a", "A");
    expect(cache.has("a")).toBe(false);
    expect(cache.stats().size).toBe(0);
  });

  it("rejects a negative or non-integer maxSize", () => {
    expect(() => createSSRCache({ maxSize: -1 })).toThrow(RangeError);
    expect(() => createSSRCache({ maxSize: 1.5 })).toThrow(RangeError);
    expect(() => createSSRCache({ maxSize: Number.NaN })).toThrow(RangeError);
  });

  it("evicts an empty-string key when it is the oldest", () => {
    vi.useFakeTimers();
    const cache = createSSRCache({ maxSize: 2 });
    cache.set("", "empty");
    vi.advanceTimersByTime(1);
    cache.set("b", "B");
    vi.advanceTimersByTime(1);
    cache.set("c", "C");

    expect(cache.has("")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.stats().size).toBe(2);
  });

  it("drops expired entries before evicting valid ones", () => {
    vi.useFakeTimers();
    const cache = createSSRCache({ maxSize: 2, defaultTTL: 0 });
    cache.set("keep", "old but valid");
    vi.advanceTimersByTime(1);
    cache.set("expiring", "short-lived", 5);
    vi.advanceTimersByTime(10);

    cache.set("new", "N");

    expect(cache.has("keep")).toBe(true);
    expect(cache.has("new")).toBe(true);
    expect(cache.stats().size).toBe(2);
  });

  it("never exceeds maxSize", () => {
    const cache = createSSRCache({ maxSize: 3 });
    for (let i = 0; i < 20; i++) {
      cache.set(`k${i % 7}`, String(i));
      expect(cache.stats().size).toBeLessThanOrEqual(3);
    }
  });
});

describe("prerenderRoutes bounds", () => {
  it("duplicate paths do not evict unrelated routes", () => {
    const routes = prerenderRoutes(
      [
        { path: "/a", component: el("A") },
        { path: "/b", component: el("B") },
        { path: "/b", component: el("B2") },
      ],
      { maxCacheSize: 2 },
    );

    expect(routes.has("/a")).toBe(true);
    expect(routes.get("/b")).toContain("B2");
    expect(routes.stats().size).toBe(2);
  });

  it("maxCacheSize: 0 caches nothing", () => {
    const routes = prerenderRoutes([{ path: "/a", component: el("A") }], { maxCacheSize: 0 });
    expect(routes.has("/a")).toBe(false);
    expect(routes.stats().size).toBe(0);
  });

  it("rejects an invalid maxCacheSize", () => {
    expect(() => prerenderRoutes([], { maxCacheSize: -2 })).toThrow(RangeError);
  });
});

describe("deferNonCritical progress", () => {
  function stubIdle() {
    const callbacks: Array<{ cb: IdleRequestCallback; options?: IdleRequestOptions }> = [];
    vi.stubGlobal("requestIdleCallback", (cb: IdleRequestCallback, options?: IdleRequestOptions) => {
      callbacks.push({ cb, options });
      return callbacks.length;
    });
    const deadline = (remaining: number, didTimeout: boolean): IdleDeadline => ({
      timeRemaining: () => remaining,
      didTimeout,
    });
    return { callbacks, deadline };
  }

  it("schedules with a finite timeout", () => {
    const { callbacks } = stubIdle();
    deferNonCritical([() => {}]);
    expect(callbacks[0].options?.timeout).toBeGreaterThan(0);
    expect(Number.isFinite(callbacks[0].options?.timeout)).toBe(true);
  });

  it("repeated zero-budget deadlines still run every task", () => {
    const { callbacks, deadline } = stubIdle();
    const tasks = [vi.fn(), vi.fn(), vi.fn()];
    deferNonCritical(tasks);

    for (let i = 0; i < 10 && callbacks.length > 0; i++) {
      callbacks.shift()!.cb(deadline(0, false));
    }

    for (const task of tasks) expect(task).toHaveBeenCalledTimes(1);
  });

  it("didTimeout: true forces progress", () => {
    const { callbacks, deadline } = stubIdle();
    const task = vi.fn();
    deferNonCritical([task]);

    callbacks.shift()!.cb(deadline(0, true));

    expect(task).toHaveBeenCalledTimes(1);
  });

  it("chunks work when a useful idle budget exists", () => {
    const { callbacks } = stubIdle();
    let remaining = 3;
    const tasks = Array.from({ length: 5 }, () =>
      vi.fn(() => {
        remaining--;
      }),
    );
    deferNonCritical(tasks);

    callbacks.shift()!.cb({ timeRemaining: () => Math.max(remaining, 0), didTimeout: false });
    const ranFirst = tasks.filter((t) => t.mock.calls.length > 0).length;
    expect(ranFirst).toBe(3);
    expect(callbacks).toHaveLength(1);

    remaining = 100;
    callbacks.shift()!.cb({ timeRemaining: () => remaining, didTimeout: false });
    for (const task of tasks) expect(task).toHaveBeenCalledTimes(1);
  });

  it("a failing task is reported and later tasks still run", () => {
    const reports: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
    setRuntimeErrorHandler((error, context) => reports.push({ error, context }));
    const { callbacks, deadline } = stubIdle();
    const later = vi.fn();
    deferNonCritical([
      () => {
        throw new Error("deferred failure");
      },
      later,
    ]);

    while (callbacks.length > 0) callbacks.shift()!.cb(deadline(50, false));

    expect(later).toHaveBeenCalledTimes(1);
    expect(reports).toHaveLength(1);
    expect((reports[0].error as Error).message).toBe("deferred failure");
  });
});
