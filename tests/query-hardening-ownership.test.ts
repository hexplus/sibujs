/**
 * Query async-ownership invariants.
 *
 *   Subscriber A ─┐
 *                 ├─► one shared in-flight request
 *   Subscriber B ─┘
 *
 * If A disappears, B must remain valid. A's lifecycle may not dictate B's
 * request lifetime, and no observer may be left fetching forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearQueryCache, invalidateQueries, query } from "../src/data/query";

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

describe("query ownership: shared in-flight requests", () => {
  beforeEach(() => {
    clearQueryCache();
  });

  afterEach(() => {
    clearQueryCache();
    vi.restoreAllMocks();
  });

  it("deduplicates concurrent subscribers onto one underlying fetch", async () => {
    const gate = createDeferred<string>();
    const fetcher = vi.fn(() => gate.promise);

    const a = query(() => "profile", fetcher);
    const b = query(() => "profile", fetcher);
    await settle();

    expect(fetcher).toHaveBeenCalledTimes(1);

    gate.resolve("alice");
    await settle();

    expect(a.data()).toBe("alice");
    expect(b.data()).toBe("alice");
    a.dispose();
    b.dispose();
  });

  it("QRY-002 — a deduplicated waiter must not stay fetching forever", async () => {
    const gate = createDeferred<string>();
    const fetcher = vi.fn(() => gate.promise);

    const a = query(() => "profile", fetcher);
    await settle();
    // B joins the in-flight request as a waiter.
    const b = query(() => "profile", fetcher);
    await settle();

    expect(b.fetching()).toBe(true);

    gate.resolve("alice");
    await settle();

    // The shared request is done — no observer may remain in a fetching state.
    expect(a.fetching()).toBe(false);
    expect(b.fetching()).toBe(false);
    expect(b.data()).toBe("alice");

    a.dispose();
    b.dispose();
  });

  it("QRY-002 — a waiter must not stay fetching when the shared request rejects", async () => {
    const gate = createDeferred<string>();
    const fetcher = vi.fn(() => gate.promise);

    const a = query(() => "profile", fetcher, { retry: { maxRetries: 0 } });
    await settle();
    const b = query(() => "profile", fetcher, { retry: { maxRetries: 0 } });
    await settle();

    gate.reject(new Error("boom"));
    await settle();

    expect(a.fetching()).toBe(false);
    expect(b.fetching()).toBe(false);

    a.dispose();
    b.dispose();
  });

  it("QRY-001 — one subscriber changing key must not cancel work another still needs", async () => {
    const profileGate = createDeferred<string>();
    let profileSignal: AbortSignal | undefined;

    const fetcher = vi.fn(({ signal, key }: { signal: AbortSignal; key: string }) => {
      if (key === "profile") {
        profileSignal = signal;
        return profileGate.promise;
      }
      return Promise.resolve(`data-${key}`);
    });

    const [keyA, setKeyA] = await import("../src/core/signals/signal").then((m) => m.signal("profile"));

    const a = query(keyA, fetcher);
    await settle();
    const b = query(() => "profile", fetcher);
    await settle();

    expect(fetcher).toHaveBeenCalledTimes(1);

    // A loses interest in "profile"; B still wants it.
    setKeyA("settings");
    await settle();

    // INVARIANT: the shared request B depends on must not be aborted.
    expect(profileSignal?.aborted).toBe(false);

    profileGate.resolve("alice");
    await settle();

    expect(b.data()).toBe("alice");
    expect(b.fetching()).toBe(false);

    a.dispose();
    b.dispose();
  });

  it("QRY-001 — disposing one subscriber must not cancel a shared request", async () => {
    const gate = createDeferred<string>();
    let sharedSignal: AbortSignal | undefined;
    const fetcher = vi.fn(({ signal }: { signal: AbortSignal }) => {
      sharedSignal = signal;
      return gate.promise;
    });

    const a = query(() => "profile", fetcher);
    await settle();
    const b = query(() => "profile", fetcher);
    await settle();

    a.dispose();
    await settle();

    expect(sharedSignal?.aborted).toBe(false);

    gate.resolve("alice");
    await settle();

    // B still gets its result.
    expect(b.data()).toBe("alice");
    expect(b.fetching()).toBe(false);
    b.dispose();
  });

  it("a disposed subscriber receives no local state commit", async () => {
    const gate = createDeferred<string>();
    const fetcher = vi.fn(() => gate.promise);

    const a = query(() => "profile", fetcher);
    const b = query(() => "profile", fetcher);
    await settle();

    a.dispose();
    gate.resolve("alice");
    await settle();

    expect(a.data()).toBeUndefined();
    expect(b.data()).toBe("alice");
    b.dispose();
  });

  it("keeps the underlying fetch count at one for ten concurrent subscribers", async () => {
    const gate = createDeferred<string>();
    const fetcher = vi.fn(() => gate.promise);

    const queries = Array.from({ length: 10 }, () => query(() => "shared", fetcher));
    await settle();

    expect(fetcher).toHaveBeenCalledTimes(1);

    gate.resolve("value");
    await settle();

    for (const q of queries) {
      expect(q.data()).toBe("value");
      expect(q.fetching()).toBe(false);
    }
    for (const q of queries) q.dispose();
  });
});

describe("query ownership: generation safety (ABA)", () => {
  beforeEach(() => {
    clearQueryCache();
  });

  afterEach(() => {
    clearQueryCache();
    vi.restoreAllMocks();
  });

  it("QRY-003 — a superseded generation must not commit to the same key", async () => {
    const first = createDeferred<string>();
    const second = createDeferred<string>();

    let calls = 0;
    const fetcher = vi.fn(() => {
      calls++;
      return calls === 1 ? first.promise : second.promise;
    });

    const a = query(() => "K", fetcher, { staleTime: 0 });
    await settle();
    expect(calls).toBe(1);

    // Drop the entry while its request is still in flight. A later query for
    // the same key therefore starts a genuinely NEW generation rather than
    // deduplicating onto the old one.
    clearQueryCache();

    const b = query(() => "K", fetcher, { staleTime: 0 });
    await settle();
    expect(calls).toBe(2);

    // The current generation resolves first.
    second.resolve("new");
    await settle();
    expect(b.data()).toBe("new");

    // Now the abandoned generation resolves. Same key, older generation.
    first.resolve("stale");
    await settle();

    // INVARIANT: key equality does not grant commit permission.
    expect(b.data()).toBe("new");
    expect(b.fetching()).toBe(false);

    a.dispose();
    b.dispose();
  });

  it("deduplicates rather than racing when a key is revisited mid-flight", async () => {
    const { signal } = await import("../src/core/signals/signal");
    const gate = createDeferred<string>();
    const fetcher = vi.fn(({ key }: { key: string }) => (key === "A" ? gate.promise : Promise.resolve("B-data")));

    const [key, setKey] = signal("A");
    const q = query(key, fetcher, { staleTime: 0 });
    await settle();

    setKey("B");
    await settle();
    setKey("A");
    await settle();

    // A's request never settled, so returning to A joins it — one A fetch only.
    expect(fetcher.mock.calls.filter((c) => c[0].key === "A")).toHaveLength(1);

    gate.resolve("A-data");
    await settle();

    expect(q.data()).toBe("A-data");
    expect(q.fetching()).toBe(false);
    q.dispose();
  });
});

describe("query ownership: cache lifecycle during in-flight work", () => {
  beforeEach(() => {
    clearQueryCache();
  });

  afterEach(() => {
    clearQueryCache();
    vi.restoreAllMocks();
  });

  it("clearQueryCache during a fetch does not leave the observer stuck", async () => {
    const gate = createDeferred<string>();
    const fetcher = vi.fn(() => gate.promise);

    const q = query(() => "profile", fetcher);
    await settle();

    clearQueryCache();
    gate.resolve("late");
    await settle();

    // Whatever the repopulation policy, the observer must reach a terminal
    // state rather than hanging in `fetching`.
    expect(q.fetching()).toBe(false);
    q.dispose();
  });

  it("invalidateQuery during a fetch does not leave the observer stuck", async () => {
    const gate = createDeferred<string>();
    const fetcher = vi.fn(() => gate.promise);

    const q = query(() => "profile", fetcher);
    await settle();

    invalidateQueries("profile");
    gate.resolve("value");
    await settle();

    expect(q.fetching()).toBe(false);
    q.dispose();
  });

  it("does not raise an unhandled rejection when a cleared cache's request fails", async () => {
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const gate = createDeferred<string>();
    const q = query(
      () => "profile",
      () => gate.promise,
      { retry: { maxRetries: 0 } },
    );
    await settle();

    clearQueryCache();
    gate.reject(new Error("boom"));
    await settle();
    await new Promise((r) => setTimeout(r, 20));

    process.off("unhandledRejection", onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();

    q.dispose();
    warn.mockRestore();
  });
});

describe("query ownership: a stale generation owns nothing", () => {
  beforeEach(() => {
    clearQueryCache();
  });

  afterEach(() => {
    clearQueryCache();
    vi.restoreAllMocks();
  });

  it("a stale generation must not clear a newer request's in-flight state", async () => {
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    let calls = 0;

    const fetcher = vi.fn(() => {
      calls++;
      return calls === 1 ? first.promise : second.promise;
    });

    const a = query(() => "K", fetcher, { staleTime: 0 });
    await settle();
    expect(calls).toBe(1);

    // Drop the entry so the next query starts a NEW generation for the same key.
    clearQueryCache();
    const b = query(() => "K", fetcher, { staleTime: 0 });
    await settle();
    expect(calls).toBe(2);

    // The abandoned generation settles while the newer one is still in flight.
    first.resolve("stale");
    await settle();

    // A late joiner must still deduplicate onto the LIVE request rather than
    // starting a third: the stale generation must not have nulled entry.promise.
    const c = query(() => "K", fetcher, { staleTime: 0 });
    await settle();
    expect(calls).toBe(2);

    second.resolve("live");
    await settle();

    expect(b.data()).toBe("live");
    expect(c.data()).toBe("live");
    expect(c.fetching()).toBe(false);

    a.dispose();
    b.dispose();
    c.dispose();
  });

  it("a stale generation must not fire onSettled for the current key", async () => {
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    let calls = 0;
    const onSettled = vi.fn();

    const fetcher = vi.fn(() => {
      calls++;
      return calls === 1 ? first.promise : second.promise;
    });

    const a = query(() => "K", fetcher, { staleTime: 0, onSettled });
    await settle();

    clearQueryCache();
    const b = query(() => "K", fetcher, { staleTime: 0 });
    await settle();

    onSettled.mockClear();
    first.resolve("stale");
    await settle();

    // The abandoned generation is not the owner — it may not report settlement.
    expect(onSettled).not.toHaveBeenCalled();

    a.dispose();
    b.dispose();
  });
});
