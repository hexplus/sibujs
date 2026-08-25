/**
 * `clearQueryCache()` abandonment semantics.
 *
 * Clearing discards every entry, so every request an entry owns is abandoned:
 * cancelled, and superseded so a late settle cannot commit, report settlement,
 * or interfere with the refetch that `clearQueryCache()` itself kicks off.
 *
 * This lives in its own file because the behaviour spans two functions that
 * look nearly identical in source (`clearQueryCache` and `__resetQueryCache`) —
 * a fix applied to only one of them passes most tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQueryCache, query } from "../src/data/query";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 15; j++) await Promise.resolve();
  }
};

describe("clearQueryCache: abandons in-flight requests", () => {
  beforeEach(() => clearQueryCache());
  afterEach(() => {
    clearQueryCache();
    vi.restoreAllMocks();
  });

  it("aborts the request an entry owned", async () => {
    const gate = createDeferred<string>();
    let seen: AbortSignal | undefined;
    const q = query(
      () => "K",
      ({ signal }) => {
        seen ??= signal;
        return gate.promise;
      },
      { staleTime: 0 },
    );
    await settle();
    expect(seen?.aborted).toBe(false);

    clearQueryCache();
    expect(seen?.aborted).toBe(true);

    q.dispose();
  });

  it("restarts live subscribers rather than leaving them empty", async () => {
    let calls = 0;
    const q = query(
      () => "K",
      () => {
        calls++;
        return Promise.resolve(`v${calls}`);
      },
      { staleTime: 0 },
    );
    await settle();
    expect(q.data()).toBe("v1");

    clearQueryCache();
    await settle();

    // The subscriber is refetched, not stranded.
    expect(q.data()).toBe("v2");
    expect(q.fetching()).toBe(false);
    q.dispose();
  });

  it("a request abandoned by clearing cannot report settlement afterwards", async () => {
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    let calls = 0;
    const onSettled = vi.fn();

    const q = query(
      () => "K",
      () => {
        calls++;
        return calls === 1 ? first.promise : second.promise;
      },
      { staleTime: 0, onSettled },
    );
    await settle();

    clearQueryCache();
    await settle();
    onSettled.mockClear();

    first.resolve("stale");
    await settle();

    expect(onSettled).not.toHaveBeenCalled();

    second.resolve("live");
    await settle();
    expect(q.data()).toBe("live");

    q.dispose();
  });
});
