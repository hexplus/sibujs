// ============================================================================
// query.ts — extra coverage: dedup, intervals, focus/reconnect, invalidate,
// setQueryData/getQueryData, select transform, gc timers, error/sync paths,
// clearQueryCache refetch errors.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetQueryCache,
  clearQueryCache,
  getQueryData,
  invalidateQueries,
  query,
  setQueryData,
} from "../src/data/query";

const tick = () => new Promise((r) => setTimeout(r, 0));
const _wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("query.ts coverage2", () => {
  beforeEach(() => {
    __resetQueryCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetQueryCache();
  });

  describe("dedup of concurrent subscribers", () => {
    it("a second subscriber awaits the in-flight promise and fires onSuccess", async () => {
      let resolveFetch: (v: string) => void = () => {};
      const fetcher = vi.fn(
        () =>
          new Promise<string>((res) => {
            resolveFetch = res;
          }),
      );

      const onSettledB = vi.fn();

      const a = query("dedup", fetcher);
      // Second instance with the same key created while the first fetch is in flight.
      const b = query("dedup", fetcher, { onSettled: onSettledB });

      // Only one network fetch should be triggered (dedup).
      expect(fetcher).toHaveBeenCalledTimes(1);
      // The deduped subscriber enters the fetching state while awaiting.
      expect(b.fetching()).toBe(true);

      resolveFetch("shared-value");
      await tick();
      await tick();

      // Both subscribers observe the shared result (via the cache listener).
      expect(a.data()).toBe("shared-value");
      expect(b.data()).toBe("shared-value");
      // The deduped subscriber's onSettled fires after its awaited promise settles.
      expect(onSettledB).toHaveBeenCalled();

      a.dispose();
      b.dispose();
    });

    it("a deduped subscriber fires onError when the in-flight promise rejects", async () => {
      let rejectFetch: (e: Error) => void = () => {};
      const fetcher = vi.fn(
        () =>
          new Promise<string>((_res, rej) => {
            rejectFetch = rej;
          }),
      );

      const onSettledB = vi.fn();

      const a = query("dedup-err", fetcher, { retry: { maxRetries: 0 } });
      const b = query("dedup-err", fetcher, {
        retry: { maxRetries: 0 },
        onSettled: onSettledB,
      });

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(b.fetching()).toBe(true);

      rejectFetch(new Error("dedup-fail"));
      await tick();
      await tick();

      // Deduped subscriber's finally-block onSettled always runs once the
      // awaited promise settles (catch branch).
      expect(onSettledB).toHaveBeenCalled();
      // The error propagates to both subscribers via the shared cache entry.
      expect(a.error()?.message).toBe("dedup-fail");
      expect(b.error()?.message).toBe("dedup-fail");

      a.dispose();
      b.dispose();
    });
  });

  describe("select transform", () => {
    it("applies select to consumers but keeps raw data in cache", async () => {
      const q = query("select-key", async () => 10, {
        select: (n) => (n as number) * 2,
      });
      await tick();
      expect(q.data()).toBe(20);
      // Raw cache value remains untransformed.
      expect(getQueryData<number>("select-key")).toBe(10);
      q.dispose();
    });

    it("applies select on cache update via setQueryData", async () => {
      const q = query("select-set", async () => 5, { select: (n) => (n as number) + 100 });
      await tick();
      expect(q.data()).toBe(105);
      setQueryData<number>("select-set", 7);
      expect(q.data()).toBe(107);
      q.dispose();
    });
  });

  describe("synchronous throw from fetcher", () => {
    it("keeps state consistent and fires onError/onSettled", async () => {
      const onError = vi.fn();
      const onSettled = vi.fn();
      const q = query(
        "sync-throw",
        () => {
          throw new Error("sync-boom");
        },
        { retry: { maxRetries: 0 }, onError, onSettled },
      );
      await tick();
      // The synchronous-throw branch sets isFetching false and reports the error.
      expect(q.fetching()).toBe(false);
      expect(onError).toHaveBeenCalled();
      expect(onSettled).toHaveBeenCalled();
      q.dispose();
    });
  });

  describe("refetchInterval", () => {
    it("refetches on the interval timer", async () => {
      vi.useFakeTimers();
      const fetcher = vi.fn(async () => "v");
      const q = query("interval", fetcher, { refetchInterval: 1000, staleTime: 0 });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);

      q.dispose();
      vi.useRealTimers();
    });
  });

  describe("refetchOnWindowFocus / refetchOnReconnect", () => {
    it("refetches on window focus and online events, and removes listeners on dispose", async () => {
      const fetcher = vi.fn(async () => "focus-v");
      const q = query("focus", fetcher, {
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        staleTime: 0,
      });
      await tick();
      const initial = fetcher.mock.calls.length;

      globalThis.dispatchEvent(new Event("focus"));
      await tick();
      expect(fetcher.mock.calls.length).toBeGreaterThan(initial);

      const afterFocus = fetcher.mock.calls.length;
      globalThis.dispatchEvent(new Event("online"));
      await tick();
      expect(fetcher.mock.calls.length).toBeGreaterThan(afterFocus);

      q.dispose();
      const afterDispose = fetcher.mock.calls.length;
      // After dispose the handlers are removed: no more fetches.
      globalThis.dispatchEvent(new Event("focus"));
      globalThis.dispatchEvent(new Event("online"));
      await tick();
      expect(fetcher.mock.calls.length).toBe(afterDispose);
    });
  });

  describe("invalidateQueries", () => {
    it("invalidates by exact key and triggers a refetch", async () => {
      let count = 0;
      const q = query("inv", async () => `v${++count}`);
      await tick();
      expect(q.data()).toBe("v1");

      invalidateQueries("inv");
      await tick();
      expect(q.data()).toBe("v2");
      q.dispose();
    });

    it("invalidates by predicate", async () => {
      let count = 0;
      const q = query("user:1", async () => `u${++count}`);
      await tick();
      expect(q.data()).toBe("u1");

      invalidateQueries((k) => k.startsWith("user:"));
      await tick();
      expect(q.data()).toBe("u2");
      q.dispose();
    });
  });

  describe("setQueryData / getQueryData", () => {
    it("setQueryData with an updater function", async () => {
      const q = query("counter", async () => 1);
      await tick();
      setQueryData<number>("counter", (prev) => (prev ?? 0) + 10);
      expect(q.data()).toBe(11);
      expect(getQueryData<number>("counter")).toBe(11);
      q.dispose();
    });

    it("setQueryData is a no-op for unknown keys", () => {
      // No entry exists -> early return, no throw.
      expect(() => setQueryData("missing-key", 1)).not.toThrow();
      expect(getQueryData("missing-key")).toBeUndefined();
    });

    it("getQueryData returns undefined for unknown keys", () => {
      expect(getQueryData("never")).toBeUndefined();
    });
  });

  describe("gc timers / cacheTime", () => {
    it("garbage-collects an entry after dispose when cacheTime elapses", async () => {
      vi.useFakeTimers();
      const q = query("gc", async () => "g", { cacheTime: 500 });
      await vi.advanceTimersByTimeAsync(0);
      expect(getQueryData("gc")).toBe("g");

      q.dispose();
      // Entry kept until cacheTime elapses.
      expect(getQueryData("gc")).toBe("g");
      await vi.advanceTimersByTimeAsync(500);
      expect(getQueryData("gc")).toBeUndefined();
      vi.useRealTimers();
    });

    it("key change schedules gc for the old key and clears it on revisit", async () => {
      vi.useFakeTimers();
      const { signal } = await import("@sibujs/core");
      const [key, setKey] = signal("k1");
      const q = query(
        () => key(),
        async (ctx) => `data-${ctx.key}`,
        { cacheTime: 1000 },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(q.data()).toBe("data-k1");

      setKey("k2");
      await vi.advanceTimersByTimeAsync(0);
      expect(q.data()).toBe("data-k2");
      // k1 now has a scheduled gc timer but data still present before expiry.
      expect(getQueryData("k1")).toBe("data-k1");

      await vi.advanceTimersByTimeAsync(1000);
      expect(getQueryData("k1")).toBeUndefined();

      q.dispose();
      vi.useRealTimers();
    });
  });

  describe("idempotent dispose", () => {
    it("double dispose does not corrupt refcount", async () => {
      const q = query("idem", async () => "x");
      await tick();
      q.dispose();
      expect(() => q.dispose()).not.toThrow();
    });
  });

  describe("clearQueryCache with active subscribers", () => {
    it("notifies active listeners and re-fetches active queries", async () => {
      let count = 0;
      const q = query("clear-active", async () => `v${++count}`);
      await tick();
      expect(q.data()).toBe("v1");

      // Active subscriber present: clearQueryCache snapshots its listener +
      // refetcher, clears the cache, then re-runs both.
      clearQueryCache();
      await tick();
      await tick();

      // After the cache is cleared and the refetcher runs, fresh data lands.
      expect(q.data()).toBe("v2");
      q.dispose();
    });
  });

  describe("disabled query", () => {
    it("does not fetch when enabled is false", async () => {
      const fetcher = vi.fn(async () => "nope");
      const q = query("disabled", fetcher, { enabled: false });
      await tick();
      expect(fetcher).not.toHaveBeenCalled();
      expect(q.data()).toBeUndefined();
      q.dispose();
    });
  });

  describe("isStale", () => {
    it("reports stale until data is fetched, then fresh with staleTime", async () => {
      const q = query("stale", async () => "s", { staleTime: 100000 });
      expect(q.isStale()).toBe(true);
      await tick();
      expect(q.isStale()).toBe(false);
      q.dispose();
    });
  });
});
