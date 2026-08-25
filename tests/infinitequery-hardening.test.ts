/**
 * infiniteQuery abort-path ownership.
 *
 * The distinction that matters:
 *
 *   stale aborted run   → do nothing (a newer run owns the flags)
 *   current aborted run → clear ITS flags, or it fetches forever
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { infiniteQuery } from "../src/data/infiniteQuery";

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

const OPTS = {
  getNextPageParam: (_last: unknown, all: unknown[]) => all.length,
  getPreviousPageParam: () => undefined,
  retry: { maxRetries: 0 },
};

describe("infiniteQuery: abort terminates fetching state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("INF-001 — an aborted initial fetch must not leave `fetching` true", async () => {
    const q = infiniteQuery(
      () => "k1",
      () => Promise.reject(new DOMException("Aborted", "AbortError")),
      OPTS as never,
    );
    await settle();

    expect(q.fetching()).toBe(false);
    expect(q.fetchingNextPage()).toBe(false);
    expect(q.fetchingPreviousPage()).toBe(false);
    q.dispose();
  });

  it("INF-001 — an aborted next-page fetch must not leave `fetchingNextPage` true", async () => {
    let call = 0;
    const q = infiniteQuery(
      () => "k2",
      () => {
        call++;
        if (call === 1) return Promise.resolve("page-1");
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      },
      OPTS as never,
    );
    await settle();
    expect(q.fetching()).toBe(false);

    await q.fetchNextPage();
    await settle();

    expect(q.fetchingNextPage()).toBe(false);
    expect(q.fetching()).toBe(false);
    q.dispose();
  });

  it("recognises a plain { name: 'AbortError' } rejection", async () => {
    const q = infiniteQuery(
      () => "k3",
      () => Promise.reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
      OPTS as never,
    );
    await settle();

    expect(q.fetching()).toBe(false);
    q.dispose();
  });

  it("does not surface an abort as an application error", async () => {
    const onError = vi.fn();
    const q = infiniteQuery(
      () => "k4",
      () => Promise.reject(new DOMException("Aborted", "AbortError")),
      { ...OPTS, onError } as never,
    );
    await settle();

    expect(onError).not.toHaveBeenCalled();
    expect(q.error()).toBeUndefined();
    q.dispose();
  });

  it("still reports a genuine error and terminates fetching", async () => {
    const onError = vi.fn();
    const q = infiniteQuery(
      () => "k5",
      () => Promise.reject(new Error("network down")),
      { ...OPTS, onError } as never,
    );
    await settle();

    expect(q.error()?.message).toBe("network down");
    expect(q.fetching()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    q.dispose();
  });

  it("a stale aborted run must not clear flags owned by a newer run", async () => {
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    let call = 0;

    const q = infiniteQuery(
      () => "k6",
      () => {
        call++;
        return call === 1 ? first.promise : second.promise;
      },
      OPTS as never,
    );
    await settle();

    // Supersede the in-flight run.
    void q.refetch();
    await settle();
    expect(q.fetching()).toBe(true);

    // The abandoned first run aborts — it must not touch the newer run's flags.
    first.reject(new DOMException("Aborted", "AbortError"));
    await settle();
    expect(q.fetching()).toBe(true);

    // The owning run completes and clears them.
    second.resolve("page-1");
    await settle();
    expect(q.fetching()).toBe(false);

    q.dispose();
  });

  it("a late resolution after dispose does not append pages", async () => {
    const gate = createDeferred<string>();
    const q = infiniteQuery(
      () => "k7",
      () => gate.promise,
      OPTS as never,
    );
    await settle();

    q.dispose();
    gate.resolve("late-page");
    await settle();

    expect(q.pages()).toEqual([]);
  });
});
