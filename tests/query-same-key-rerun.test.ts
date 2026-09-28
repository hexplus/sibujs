/**
 * A reactive key that recomputes to the SAME resolved key is not a key change.
 *
 * `query(() => `user:${id() % 10}`, fetcher)` tracks `id`. When `id` moves from
 * 1 to 11 the key effect re-runs, but the resolved key is still "user:1". That
 * re-run used to fall into the same-key staleness branch and — with the default
 * `staleTime: 0` — refetch, so applications wrapped every key in `derived()`
 * just to stop it.
 *
 * Invariant: the key effect re-running is not, by itself, a reason to fetch.
 * A fetch is warranted by first mount, an actual key change, `enabled` rising,
 * the observer being re-attached to a replaced cache entry, or an explicit
 * trigger (`refetch()`, `invalidateQueries()`, interval, focus, reconnect).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signal } from "../src/core/signals/signal";
import {
  __resetQueryCache,
  clearQueryCache,
  invalidateQueries,
  type QueryResult,
  query,
  setQueryData,
} from "../src/data/query";

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 15; j++) await Promise.resolve();
  }
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A fetcher returning `${key}#${n}` for its n-th call. */
function countingFetcher() {
  let n = 0;
  return vi.fn(({ key }: { key: string }) => Promise.resolve(`${key}#${++n}`));
}

const disposers: Array<() => void> = [];
function keep<T>(q: QueryResult<T>): QueryResult<T> {
  disposers.push(q.dispose);
  return q;
}

beforeEach(() => __resetQueryCache());
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
  __resetQueryCache();
  vi.useRealTimers();
});

describe("query(): a same-key reactive re-run does not refetch", () => {
  it("dependency changes, resolved key unchanged → no extra fetch", async () => {
    const [id, setId] = signal(1);
    const fetcher = countingFetcher();
    const q = keep(query(() => `user:${id() % 10}`, fetcher));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(q.data()).toBe("user:1#1");

    setId(11);
    setId(21);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(q.data()).toBe("user:1#1");
    expect(q.fetching()).toBe(false);
  });

  it("an actual key change fetches", async () => {
    const [id, setId] = signal(1);
    const fetcher = countingFetcher();
    const q = keep(query(() => `user:${id() % 10}`, fetcher));
    await settle();

    setId(2);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith(expect.objectContaining({ key: "user:2" }));
    expect(q.data()).toBe("user:2#2");
  });

  it("A → B → A still refetches the stale A entry on return", async () => {
    const [id, setId] = signal(1);
    const fetcher = countingFetcher();
    const q = keep(query(() => `user:${id()}`, fetcher));
    await settle();
    setId(2);
    await settle();
    setId(1);
    await settle();
    expect(fetcher.mock.calls.map(([ctx]) => ctx.key)).toEqual(["user:1", "user:2", "user:1"]);
    expect(q.data()).toBe("user:1#3");
  });

  it("staleTime: 0 (explicit) does not reintroduce the same-key refetch", async () => {
    const [id, setId] = signal(3);
    const fetcher = countingFetcher();
    keep(query(() => `k:${id() % 2}`, fetcher, { staleTime: 0 }));
    await settle();
    for (const n of [5, 7, 9, 11]) {
      setId(n);
      await settle();
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("data that went stale under a finite staleTime is not refetched by a same-key re-run", async () => {
    vi.useFakeTimers();
    const [id, setId] = signal(1);
    const fetcher = countingFetcher();
    keep(query(() => `user:${id() % 10}`, fetcher, { staleTime: 1000 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    setId(11);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("a same-key re-run after a failed fetch does not retry it", async () => {
    const [id, setId] = signal(1);
    const fetcher = vi.fn(() => Promise.reject(new Error("boom")));
    const q = keep(query(() => `user:${id() % 10}`, fetcher, { retry: { maxRetries: 0 } }));
    await settle();
    expect(q.error()?.message).toBe("boom");

    setId(11);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(q.error()?.message).toBe("boom");
  });

  it("a same-key re-run while a request is in flight neither refetches nor strands `fetching`", async () => {
    const [id, setId] = signal(1);
    const pending = deferred<string>();
    const fetcher = vi.fn(() => pending.promise);
    const q = keep(query(() => `user:${id() % 10}`, fetcher));
    expect(q.fetching()).toBe(true);

    setId(11);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(q.fetching()).toBe(true);

    pending.resolve("done");
    await settle();
    expect(q.data()).toBe("done");
    expect(q.fetching()).toBe(false);
  });

  it("initialData is kept and not refetched by a same-key re-run", async () => {
    const [id, setId] = signal(1);
    const fetcher = countingFetcher();
    const q = keep(query(() => `user:${id() % 10}`, fetcher, { initialData: "seed", staleTime: 60_000 }));
    await settle();
    // Fresh initialData: no mount fetch.
    expect(fetcher).toHaveBeenCalledTimes(0);
    expect(q.data()).toBe("seed");

    setId(11);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(0);
    expect(q.data()).toBe("seed");
  });
});

describe("query(): legitimate same-key fetches still happen", () => {
  it("refetch() fetches after a same-key re-run", async () => {
    const [id, setId] = signal(1);
    const fetcher = countingFetcher();
    const q = keep(query(() => `user:${id() % 10}`, fetcher));
    await settle();
    setId(11);
    await settle();

    await q.refetch();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(q.data()).toBe("user:1#2");
  });

  it("invalidateQueries() fetches after a same-key re-run", async () => {
    const [id, setId] = signal(1);
    const fetcher = countingFetcher();
    const q = keep(query(() => `user:${id() % 10}`, fetcher));
    await settle();
    setId(11);
    await settle();

    invalidateQueries("user:1");
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(q.data()).toBe("user:1#2");
  });

  it("window focus refetches when configured", async () => {
    const [id, setId] = signal(1);
    const fetcher = countingFetcher();
    keep(query(() => `user:${id() % 10}`, fetcher, { refetchOnWindowFocus: true }));
    await settle();
    setId(11);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    globalThis.dispatchEvent(new Event("focus"));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("reconnect refetches when configured", async () => {
    const [id, setId] = signal(1);
    const fetcher = countingFetcher();
    keep(query(() => `user:${id() % 10}`, fetcher, { refetchOnReconnect: true }));
    await settle();
    setId(11);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    globalThis.dispatchEvent(new Event("online"));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refetchInterval keeps refetching regardless of same-key re-runs", async () => {
    vi.useFakeTimers();
    const [id, setId] = signal(1);
    const fetcher = countingFetcher();
    keep(query(() => `user:${id() % 10}`, fetcher, { refetchInterval: 100 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    setId(11);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("enabled false → true fetches stale data for the unchanged key", async () => {
    const [id, setId] = signal(1);
    const [on, setOn] = signal(true);
    const fetcher = countingFetcher();
    const q = keep(query(() => `user:${id() % 10}`, fetcher, { enabled: () => on() }));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    setOn(false);
    setId(11);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    setOn(true);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(q.data()).toBe("user:1#2");
  });

  it("enabled false → true fetches a key that was never fetched", async () => {
    const [on, setOn] = signal(false);
    const [id, setId] = signal(1);
    const fetcher = countingFetcher();
    const q = keep(query(() => `user:${id() % 10}`, fetcher, { enabled: () => on() }));
    setId(11);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(0);

    setOn(true);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(q.data()).toBe("user:1#1");
  });

  it("enabled false → true respects staleTime for fresh data", async () => {
    const [on, setOn] = signal(true);
    const fetcher = countingFetcher();
    keep(query("user:1", fetcher, { enabled: () => on(), staleTime: 60_000 }));
    await settle();
    setOn(false);
    setOn(true);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("a same-key re-run re-attaches to a replaced entry and fetches the missing data", async () => {
    const [id, setId] = signal(1);
    const fetcher = countingFetcher();
    const q = keep(query(() => `user:${id() % 10}`, fetcher));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Drop the entry WITHOUT restarting observers: the next key-effect run is
    // the observer's only chance to notice its entry is gone.
    __resetQueryCache();
    setId(11);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(q.data()).toBe("user:1#2");

    // Attached to the new entry: external writes reach it.
    setQueryData("user:1", "manual");
    expect(q.data()).toBe("manual");
  });

  it("clearQueryCache() refetches and re-attaches; a later same-key re-run adds nothing", async () => {
    const [id, setId] = signal(1);
    const fetcher = countingFetcher();
    const a = keep(query(() => `user:${id() % 10}`, fetcher));
    const b = keep(query(() => "user:1", fetcher));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    clearQueryCache();
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);

    setId(11);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);

    setQueryData("user:1", "manual");
    expect(a.data()).toBe("manual");
    expect(b.data()).toBe("manual");
  });

  it("clearQueryCache() while disabled: enabling re-attaches and fetches", async () => {
    const [id, setId] = signal(1);
    const [on, setOn] = signal(true);
    const fetcher = countingFetcher();
    const q = keep(query(() => `user:${id() % 10}`, fetcher, { enabled: () => on() }));
    await settle();
    setOn(false);
    clearQueryCache();
    setId(11);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    setOn(true);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    setQueryData("user:1", "manual");
    expect(q.data()).toBe("manual");
  });
});

describe("query(): observer ownership survives same-key re-runs", () => {
  it("does not inflate the subscriber count or duplicate registrations", async () => {
    const CACHE_KEY = Symbol.for("sibujs.query.cache.v1");
    const raw = () =>
      (
        globalThis as unknown as Record<
          symbol,
          Map<string, { subscribers: number; listeners: Set<unknown>; refetchers: Set<unknown> }>
        >
      )[CACHE_KEY];
    const [id, setId] = signal(1);
    const q = keep(query(() => `user:${id() % 10}`, countingFetcher()));
    await settle();
    for (const n of [11, 21, 31]) setId(n);
    await settle();

    const entry = raw().get("user:1");
    expect(entry?.subscribers).toBe(1);
    expect(entry?.listeners.size).toBe(1);
    expect(entry?.refetchers.size).toBe(1);

    q.dispose();
    expect(entry?.subscribers).toBe(0);
    expect(entry?.listeners.size).toBe(0);
  });

  it("select and structural sharing observers are not re-notified by a same-key re-run", async () => {
    const [id, setId] = signal(1);
    const select = vi.fn((d: { n: number }) => ({ doubled: d.n * 2 }) as unknown as { n: number });
    const fetcher = vi.fn(() => Promise.resolve({ n: 21 }));
    const q = keep(query(() => `user:${id() % 10}`, fetcher, { select }));
    await settle();
    const first = q.data();
    expect(select).toHaveBeenCalledTimes(1);

    setId(11);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
    expect(q.data()).toBe(first);
  });

  it("a request still in flight for a key left behind cannot commit to the new key", async () => {
    const [id, setId] = signal(1);
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi.fn(({ key }: { key: string }) => (key === "user:1" ? first.promise : second.promise));
    const q = keep(query(() => `user:${id() % 10}`, fetcher));
    setId(11); // same key, request still in flight
    setId(2); // real key change
    second.resolve("two");
    await settle();
    first.resolve("one");
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(q.data()).toBe("two");
  });
});
