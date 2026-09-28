import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signal } from "../src/core/signals/signal";
import { clearQueryCache, getQueryData, invalidateQueries, query, setQueryData } from "../src/data/query";
import { createDeferred } from "./helpers/mocks";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("query", () => {
  beforeEach(() => {
    clearQueryCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic lifecycle", () => {
    it("fetches data and updates signals", async () => {
      const q = query("test", async () => "hello");

      expect(q.loading()).toBe(true);
      expect(q.fetching()).toBe(true);
      expect(q.data()).toBe(undefined);

      await tick();

      expect(q.loading()).toBe(false);
      expect(q.fetching()).toBe(false);
      expect(q.data()).toBe("hello");
      q.dispose();
    });

    it("handles fetch errors", async () => {
      const q = query(
        "err",
        async () => {
          throw new Error("fail");
        },
        { retry: { maxRetries: 0 } },
      );

      await tick();

      expect(q.error()?.message).toBe("fail");
      expect(q.loading()).toBe(false);
      expect(q.fetching()).toBe(false);
      q.dispose();
    });

    it("uses initialData", async () => {
      const q = query("init", async () => "fetched", {
        initialData: "initial",
      });

      expect(q.data()).toBe("initial");
      expect(q.loading()).toBe(false);

      await tick();
      expect(q.data()).toBe("fetched");
      q.dispose();
    });

    it("does not fetch when enabled is false", async () => {
      const fn = vi.fn().mockResolvedValue("data");
      const q = query("disabled", fn, { enabled: false });

      await tick();
      expect(fn).not.toHaveBeenCalled();
      expect(q.loading()).toBe(false);
      expect(q.fetching()).toBe(false);
      q.dispose();
    });
  });

  describe("reactive enabled", () => {
    it("stays idle while a function `enabled` is false, then fetches when it turns true", async () => {
      const [userId, setUserId] = signal<number | null>(null);
      const fn = vi.fn().mockImplementation(async ({ key }: { key: string }) => `data-${key}`);
      const q = query(() => `user:${userId()}`, fn, { enabled: () => userId() != null });

      await tick();
      expect(fn).not.toHaveBeenCalled();
      expect(q.fetching()).toBe(false);

      setUserId(7);
      await tick();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(q.data()).toBe("data-user:7");
      q.dispose();
    });

    it("blocks refetch(), invalidateQueries and the interval while false", async () => {
      vi.useFakeTimers();
      const [on, setOn] = signal(true);
      const fn = vi.fn().mockResolvedValue("v");
      const q = query("gated", fn, { enabled: on, refetchInterval: 100 });
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);

      setOn(false);
      await q.refetch();
      invalidateQueries("gated");
      await vi.advanceTimersByTimeAsync(500);
      expect(fn).toHaveBeenCalledTimes(1);

      // Re-enabling refetches the data invalidated while idle.
      setOn(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(2);
      q.dispose();
    });

    it("does not re-run when the function's dependencies change but its answer does not", async () => {
      const [count, setCount] = signal(1);
      const fn = vi.fn().mockResolvedValue("v");
      // staleTime 0: any re-run of the key effect would refetch.
      const q = query("steady", fn, { enabled: () => count() > 0 });
      await tick();
      expect(fn).toHaveBeenCalledTimes(1);

      setCount(2);
      setCount(3);
      await tick();
      expect(fn).toHaveBeenCalledTimes(1);
      q.dispose();
    });

    it("an empty key holds the query idle without a shared cache entry", async () => {
      const fn = vi.fn().mockResolvedValue("v");
      const a = query("", fn, { initialData: "a" });
      const b = query("", fn, { initialData: "b" });

      await tick();
      expect(fn).not.toHaveBeenCalled();
      expect(a.data()).toBe("a");
      expect(b.data()).toBe("b");
      expect(getQueryData("")).toBe(undefined);
      a.dispose();
      b.dispose();
    });

    it("leaving a key for the empty key releases it and clears fetching", async () => {
      const [key, setKey] = signal("live");
      const deferred = createDeferred<string>();
      const q = query(key, () => deferred.promise, { cacheTime: 0 });
      expect(q.fetching()).toBe(true);

      setKey("");
      expect(q.fetching()).toBe(false);

      deferred.resolve("late");
      await tick();
      expect(q.fetching()).toBe(false);
      q.dispose();
    });
  });

  describe("key change with a request in flight", () => {
    it("switching to a key with fresh cached data clears fetching", async () => {
      const seed = query("fresh", async () => "cached", { staleTime: 60_000 });
      await tick();
      seed.dispose();
      const [key, setKey] = signal("slow");
      const deferred = createDeferred<string>();
      const q = query(key, ({ key }) => (key === "slow" ? deferred.promise : Promise.resolve("refetched")), {
        staleTime: 60_000,
      });
      expect(q.fetching()).toBe(true);

      setKey("fresh");
      expect(q.data()).toBe("cached");
      expect(q.fetching()).toBe(false);

      deferred.resolve("late");
      await tick();
      expect(q.fetching()).toBe(false);
      expect(q.data()).toBe("cached");
      q.dispose();
    });

    it("switching to a key another observer is fetching reports fetching until it settles", async () => {
      const [key, setKey] = signal("a");
      const a = createDeferred<string>();
      const b = createDeferred<string>();
      const fetcher = ({ key }: { key: string }) => (key === "a" ? a.promise : b.promise);
      const other = query("b", fetcher);
      const q = query(key, fetcher);

      setKey("b");
      expect(q.fetching()).toBe(true);

      b.resolve("B");
      await tick();
      expect(q.fetching()).toBe(false);
      expect(q.data()).toBe("B");
      a.resolve("A");
      other.dispose();
      q.dispose();
    });
  });

  describe("caching", () => {
    it("shares cached data between instances with staleTime", async () => {
      const fn = vi.fn().mockResolvedValue("cached");
      const q1 = query("shared", fn, { staleTime: 60_000 });
      await tick();
      expect(q1.data()).toBe("cached");
      expect(fn).toHaveBeenCalledTimes(1);

      const q2 = query("shared", fn, { staleTime: 60_000 });
      expect(q2.data()).toBe("cached");
      await tick();
      expect(fn).toHaveBeenCalledTimes(1);

      q1.dispose();
      q2.dispose();
    });

    it("garbage collects after cacheTime", async () => {
      const q = query("gc", async () => "data", { cacheTime: 20 });
      await tick();
      expect(getQueryData("gc")).toBe("data");

      q.dispose();
      expect(getQueryData("gc")).toBe("data");

      await new Promise((r) => setTimeout(r, 50));
      expect(getQueryData("gc")).toBe(undefined);
    });
  });

  describe("reactive key", () => {
    it("refetches when key changes", async () => {
      const [key, setKey] = signal("key-1");
      const fn = vi.fn().mockImplementation(async ({ key }: { key: string }) => `data-${key}`);

      const q = query(key, fn);
      await tick();
      expect(q.data()).toBe("data-key-1");

      setKey("key-2");
      await tick();
      expect(q.data()).toBe("data-key-2");
      expect(fn).toHaveBeenCalledTimes(2);

      q.dispose();
    });
  });

  describe("cache utilities", () => {
    it("getQueryData returns cached data", async () => {
      const q = query("get", async () => "value");
      await tick();
      expect(getQueryData("get")).toBe("value");
      q.dispose();
    });

    it("setQueryData updates cache and notifies subscribers", async () => {
      const q = query("set", async () => "original");
      await tick();
      expect(q.data()).toBe("original");

      setQueryData("set", "updated");
      expect(q.data()).toBe("updated");
      expect(getQueryData("set")).toBe("updated");
      q.dispose();
    });

    it("setQueryData accepts updater function", async () => {
      const q = query("set-fn", async () => 10);
      await tick();

      setQueryData<number>("set-fn", (prev) => (prev ?? 0) + 5);
      expect(q.data()).toBe(15);
      q.dispose();
    });

    it("invalidateQueries triggers refetch", async () => {
      let count = 0;
      const q = query("inv", async () => ++count);
      await tick();
      expect(q.data()).toBe(1);

      invalidateQueries("inv");
      await tick();
      expect(q.data()).toBe(2);
      q.dispose();
    });

    it("invalidateQueries with predicate", async () => {
      let countA = 0;
      let countB = 0;
      const qA = query("users-list", async () => ++countA);
      const qB = query("posts-list", async () => ++countB);
      await tick();

      invalidateQueries((k) => k.startsWith("users"));
      await tick();

      expect(qA.data()).toBe(2);
      expect(qB.data()).toBe(1);
      qA.dispose();
      qB.dispose();
    });

    it("clearQueryCache clears all entries", async () => {
      const q1 = query("c1", async () => "a");
      const q2 = query("c2", async () => "b");
      await tick();

      clearQueryCache();
      expect(getQueryData("c1")).toBe(undefined);
      expect(getQueryData("c2")).toBe(undefined);
      q1.dispose();
      q2.dispose();
    });

    it("clearQueryCache resets active query signals and refetches", async () => {
      let count = 0;
      const q = query("clear-active", async () => ++count);
      await tick();
      expect(q.data()).toBe(1);

      clearQueryCache();
      // Signals should be reset immediately
      expect(q.data()).toBe(undefined);
      // After refetch completes, data should be available again
      await tick();
      expect(q.data()).toBe(2);
      q.dispose();
    });
  });

  describe("refetch", () => {
    it("manually refetches", async () => {
      let count = 0;
      const q = query("refetch", async () => ++count);
      await tick();
      expect(q.data()).toBe(1);

      await q.refetch();
      expect(q.data()).toBe(2);
      q.dispose();
    });
  });

  describe("refetchInterval", () => {
    it("auto-refetches on interval", async () => {
      let count = 0;
      const q = query("interval", async () => ++count, {
        refetchInterval: 50,
        staleTime: 60_000,
      });

      await tick();
      const initial = q.data() as number;
      expect(initial).toBeGreaterThanOrEqual(1);

      await new Promise((r) => setTimeout(r, 120));
      expect(q.data() as number).toBeGreaterThan(initial);

      q.dispose();
    });
  });

  describe("dispose", () => {
    it("prevents updates after disposal", async () => {
      const deferred = createDeferred<string>();
      const q = query("dispose", () => deferred.promise);

      expect(q.fetching()).toBe(true);
      q.dispose();

      deferred.resolve("data");
      await tick();

      expect(q.data()).toBe(undefined);
    });
  });

  describe("select", () => {
    it("transforms data with select option", async () => {
      const q = query("select-basic", async () => ({ items: [1, 2, 3], total: 3 }), {
        select: (data) => ({ ...data, items: data.items.filter((n) => n > 1) }),
      });
      await tick();
      expect(q.data()?.items).toEqual([2, 3]);
      q.dispose();
    });

    it("applies select when syncing from cache", async () => {
      const q = query("select-cache", async () => ({ count: 10 }), {
        select: (data) => ({ count: data.count * 2 }),
        staleTime: 60_000,
      });
      await tick();
      expect(q.data()?.count).toBe(20);

      // setQueryData updates raw cache; select is re-applied via onCacheUpdate
      setQueryData("select-cache", { count: 5 });
      expect(q.data()?.count).toBe(10);
      q.dispose();
    });
  });

  describe("callbacks", () => {
    it("calls onSuccess and onSettled on success", async () => {
      const onSuccess = vi.fn();
      const onSettled = vi.fn();

      const q = query("cb-ok", async () => "data", {
        onSuccess,
        onSettled,
      });
      await tick();

      expect(onSuccess).toHaveBeenCalledWith("data");
      expect(onSettled).toHaveBeenCalledOnce();
      q.dispose();
    });

    it("calls onError and onSettled on failure", async () => {
      const onError = vi.fn();
      const onSettled = vi.fn();

      const q = query(
        "cb-err",
        async () => {
          throw new Error("oops");
        },
        { onError, onSettled, retry: { maxRetries: 0 } },
      );
      await tick();

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "oops" }));
      expect(onSettled).toHaveBeenCalledOnce();
      q.dispose();
    });
  });
});
