/**
 * QRY-005 — observer reattachment after the cache entry is replaced.
 *
 * `clearQueryCache()` destroys every `CacheEntry` and restarts live queries. The
 * key string is unchanged, so nothing in the key-driven registration path
 * re-runs — but the concrete entry object is new:
 *
 *   same key  ≠  same CacheEntry
 *
 * A live observer must end up attached to the *current* entry, with its
 * listener, its refetcher, and its share of the subscriber count restored.
 *
 * The initial post-clear refetch is a poor probe: a detached observer still
 * awaits the shared promise directly and updates its own state, so it looks
 * healthy. `setQueryData()` is the probe that exposes a missing listener, and
 * `invalidateQueries()` the one that exposes a missing refetcher.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQueryCache, invalidateQueries, query, setQueryData } from "../src/data/query";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 15; j++) await Promise.resolve();
  }
};

/** A fetcher returning a fresh value on every call. */
function countingFetcher() {
  let n = 0;
  const fn = vi.fn(() => {
    n++;
    return Promise.resolve(`v${n}`);
  });
  return fn;
}

describe("QRY-005: observers reattach after clearQueryCache", () => {
  beforeEach(() => clearQueryCache());
  afterEach(() => {
    clearQueryCache();
    vi.restoreAllMocks();
  });

  it("a single observer still receives external cache writes after a clear", async () => {
    const fetcher = countingFetcher();
    const a = query(() => "K", fetcher, { staleTime: 0 });
    await settle();
    expect(a.data()).toBe("v1");

    clearQueryCache();
    await settle();
    expect(a.data()).toBe("v2");

    setQueryData("K", "manual");
    await settle();
    expect(a.data()).toBe("manual");

    a.dispose();
  });

  it("BOTH observers still receive external cache writes after a clear", async () => {
    const fetcher = countingFetcher();
    const a = query(() => "K", fetcher, { staleTime: 0 });
    const b = query(() => "K", fetcher, { staleTime: 0 });
    await settle();

    clearQueryCache();
    await settle();

    // The restarted fetch reaches both — this alone does NOT prove attachment.
    expect(a.data()).toBe(b.data());

    // The real probe: an external write only reaches attached listeners.
    setQueryData("K", "manual-update");
    await settle();

    expect(a.data()).toBe("manual-update");
    expect(b.data()).toBe("manual-update");

    a.dispose();
    b.dispose();
  });

  it("all ten observers receive external cache writes after a clear", async () => {
    const fetcher = countingFetcher();
    const observers = Array.from({ length: 10 }, () => query(() => "K", fetcher, { staleTime: 0 }));
    await settle();

    clearQueryCache();
    await settle();

    setQueryData("K", "broadcast");
    await settle();

    for (const q of observers) expect(q.data()).toBe("broadcast");
    for (const q of observers) q.dispose();
  });

  it("restores refetchers, so invalidation after a clear reaches every observer", async () => {
    const fetcher = countingFetcher();
    const a = query(() => "K", fetcher, { staleTime: 0 });
    const b = query(() => "K", fetcher, { staleTime: 0 });
    await settle();

    clearQueryCache();
    await settle();
    const callsAfterClear = fetcher.mock.calls.length;

    invalidateQueries("K");
    await settle();

    // A refetch actually happened (refetchers were restored)...
    expect(fetcher.mock.calls.length).toBeGreaterThan(callsAfterClear);
    // ...and both observers see the new value.
    expect(a.data()).toBe(b.data());
    expect(a.data()).not.toBeUndefined();

    a.dispose();
    b.dispose();
  });

  it("keeps deduplication — one restarted fetch for two observers", async () => {
    const fetcher = countingFetcher();
    const a = query(() => "K", fetcher, { staleTime: 0 });
    const b = query(() => "K", fetcher, { staleTime: 0 });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    clearQueryCache();
    await settle();

    // Exactly one additional underlying request, shared by both observers.
    expect(fetcher).toHaveBeenCalledTimes(2);

    a.dispose();
    b.dispose();
  });

  it("keeps the surviving observer attached after the other is disposed", async () => {
    const fetcher = countingFetcher();
    const a = query(() => "K", fetcher, { staleTime: 0 });
    const b = query(() => "K", fetcher, { staleTime: 0 });
    await settle();

    clearQueryCache();
    await settle();

    a.dispose();

    setQueryData("K", "after-A-disposed");
    await settle();

    expect(b.data()).toBe("after-A-disposed");
    b.dispose();
  });

  it("does not garbage-collect an entry that still has a live observer", async () => {
    const fetcher = countingFetcher();
    // Short cacheTime so GC would fire quickly if the refcount were wrong.
    const a = query(() => "K", fetcher, { staleTime: 0, cacheTime: 10 });
    const b = query(() => "K", fetcher, { staleTime: 0, cacheTime: 10 });
    await settle();

    clearQueryCache();
    await settle();

    a.dispose();
    await new Promise((r) => setTimeout(r, 40));

    // B is still live, so the entry must survive and still deliver updates.
    setQueryData("K", "still-here");
    await settle();
    expect(b.data()).toBe("still-here");

    b.dispose();
  });

  it("survives repeated clear cycles", async () => {
    const fetcher = countingFetcher();
    const a = query(() => "K", fetcher, { staleTime: 0 });
    const b = query(() => "K", fetcher, { staleTime: 0 });
    await settle();

    for (let i = 0; i < 3; i++) {
      clearQueryCache();
      await settle();
    }

    setQueryData("K", "final");
    await settle();

    expect(a.data()).toBe("final");
    expect(b.data()).toBe("final");

    a.dispose();
    b.dispose();
  });

  it("does not double-attach — one dispose fully detaches one observer", async () => {
    const fetcher = countingFetcher();
    const a = query(() => "K", fetcher, { staleTime: 0, cacheTime: 10 });
    await settle();

    // Several clears would each re-attach; a single dispose must still bring
    // the refcount to zero rather than leaving phantom subscribers behind.
    for (let i = 0; i < 3; i++) {
      clearQueryCache();
      await settle();
    }

    a.dispose();
    await new Promise((r) => setTimeout(r, 40));

    // With no observers left the entry is collected, so a fresh query must
    // fetch again rather than reading a retained entry.
    const callsBefore = fetcher.mock.calls.length;
    const b = query(() => "K", fetcher, { staleTime: 0 });
    await settle();

    expect(fetcher.mock.calls.length).toBeGreaterThan(callsBefore);
    b.dispose();
  });

  it("a clear during a pending restart leaves observers on the newest entry", async () => {
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    let calls = 0;
    const fetcher = vi.fn(() => {
      calls++;
      if (calls === 1) return Promise.resolve("initial");
      if (calls === 2) return first.promise;
      return second.promise;
    });

    const a = query(() => "K", fetcher, { staleTime: 0 });
    const b = query(() => "K", fetcher, { staleTime: 0 });
    await settle();

    clearQueryCache(); // restart #1 -> first.promise
    await settle();
    clearQueryCache(); // restart #2 -> second.promise, before #1 resolved
    await settle();

    // The abandoned restart resolves late and must not repopulate anything.
    first.resolve("stale");
    await settle();

    second.resolve("newest");
    await settle();

    expect(a.data()).toBe("newest");
    expect(b.data()).toBe("newest");

    // Both are attached to the newest entry.
    setQueryData("K", "post-race");
    await settle();
    expect(a.data()).toBe("post-race");
    expect(b.data()).toBe("post-race");

    a.dispose();
    b.dispose();
  });
});
