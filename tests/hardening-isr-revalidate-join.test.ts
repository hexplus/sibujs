/**
 * `createISR().revalidate()` promise ownership.
 *
 * Invariants under test:
 *  - One logical revalidation at a time. A call while one is running joins it:
 *    same promise, one fetcher execution, settled only when that fetch settles,
 *    with the same value or rejection for every caller.
 *  - After it settles the next call starts a new fetch — including a call made
 *    by a joined caller the moment it resumes.
 *  - Each settled fetch arms exactly one deadline (success: stale deadline,
 *    failure: retry), however many callers joined it; none after dispose.
 *  - Dispose during a shared request aborts it; no later state mutation or
 *    timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createISR } from "../src/platform/incrementalRegeneration";
import { createDeferred } from "./helpers/mocks";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Tracks whether a promise has settled, without awaiting it. */
function observe(p: Promise<unknown>) {
  const state = { settled: false, value: undefined as unknown, error: undefined as unknown };
  p.then(
    (v) => {
      state.settled = true;
      state.value = v;
    },
    (e) => {
      state.settled = true;
      state.error = e;
    },
  );
  return state;
}

describe("createISR: revalidate() joins the active request", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("concurrent calls run the fetcher once and settle together with it", async () => {
    const request = createDeferred<string>();
    const fetcher = vi.fn(() => request.promise);
    const isr = createISR({ revalidateAfter: 1000, fetcher, initialData: "initial" });

    const p1 = isr.revalidate();
    const p2 = isr.revalidate();
    expect(p2).toBe(p1);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const s1 = observe(p1);
    const s2 = observe(p2);
    await flush();
    expect(s1.settled).toBe(false);
    expect(s2.settled).toBe(false);

    request.resolve("fresh");
    await flush();
    expect(s1.settled).toBe(true);
    expect(s2.settled).toBe(true);
    expect(isr.data()).toBe("fresh");
    expect(isr.isStale()).toBe(false);
    isr.dispose();
  });

  it("every joined caller rejects with the same failure", async () => {
    const request = createDeferred<string>();
    const isr = createISR({ revalidateAfter: 1000, fetcher: () => request.promise, initialData: "initial" });

    const p1 = isr.revalidate();
    const p2 = isr.revalidate();
    const failure = new Error("boom");
    request.reject(failure);

    const results = await Promise.allSettled([p1, p2]);
    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    expect(isr.data()).toBe("initial");
    isr.dispose();
  });

  it("a failure arms exactly one retry, however many callers joined", async () => {
    let attempt = 0;
    const requests = [createDeferred<string>(), createDeferred<string>()];
    const fetcher = vi.fn(() => requests[attempt++].promise);
    const isr = createISR({ revalidateAfter: 1000, fetcher, initialData: "initial" });
    // The initial deadline, armed for `initialData`.
    expect(vi.getTimerCount()).toBe(1);

    const joined = Promise.allSettled([isr.revalidate(), isr.revalidate(), isr.revalidate()]);
    requests[0].reject(new Error("transient"));
    await joined;
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(isr.isStale()).toBe(true);
    isr.dispose();
  });

  it("a success arms exactly one stale deadline, however many callers joined", async () => {
    const request = createDeferred<string>();
    const fetcher = vi.fn(() => request.promise);
    const isr = createISR({ revalidateAfter: 1000, fetcher, initialData: "initial" });

    const joined = Promise.all([isr.revalidate(), isr.revalidate()]);
    request.resolve("fresh");
    await joined;
    expect(vi.getTimerCount()).toBe(1);
    isr.dispose();
  });

  it("the automatic stale revalidation joins a running manual one", async () => {
    const request = createDeferred<string>();
    const fetcher = vi.fn(() => request.promise);
    const isr = createISR({ revalidateAfter: 1000, fetcher, initialData: "initial" });

    const manual = isr.revalidate();
    // The initialData deadline fires while the manual request is running.
    vi.advanceTimersByTime(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(isr.isStale()).toBe(true);

    request.resolve("fresh");
    await manual;
    await flush();
    expect(isr.isStale()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    isr.dispose();
  });

  it("a call after settlement starts a new fetch, even from a resuming caller", async () => {
    const requests = [createDeferred<string>(), createDeferred<string>()];
    let attempt = 0;
    const fetcher = vi.fn(() => requests[attempt++].promise);
    const isr = createISR({ revalidateAfter: 1000, fetcher, initialData: "initial" });

    let second: Promise<void> | undefined;
    const first = isr.revalidate().then(() => {
      second = isr.revalidate();
    });
    requests[0].resolve("one");
    await first;
    expect(fetcher).toHaveBeenCalledTimes(2);

    requests[1].resolve("two");
    await second;
    expect(isr.data()).toBe("two");
    isr.dispose();
  });

  it("a revalidate() from inside the fetcher joins the request instead of starting another", async () => {
    const request = createDeferred<string>();
    let inner: Promise<void> | undefined;
    let isr: ReturnType<typeof createISR<string>> | undefined;
    const fetcher = vi.fn(() => {
      inner = isr?.revalidate();
      return request.promise;
    });
    isr = createISR({ revalidateAfter: 1000, fetcher, initialData: "initial" });

    const outer = isr.revalidate();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(inner).toBe(outer);
    request.resolve("fresh");
    await outer;
    isr.dispose();
  });

  it("dispose during a shared request aborts it; no mutation and no timer follow", async () => {
    const request = createDeferred<string>();
    let seen: AbortSignal | undefined;
    const fetcher = vi.fn((ctx?: { signal: AbortSignal }) => {
      seen = ctx?.signal;
      return request.promise;
    });
    const isr = createISR({ revalidateAfter: 1000, fetcher, initialData: "initial" });

    const s1 = observe(isr.revalidate());
    const s2 = observe(isr.revalidate());
    isr.dispose();
    expect(seen?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // A fetcher that ignores the signal and resolves anyway changes nothing.
    request.resolve("late");
    await flush();
    expect(s1.settled && s2.settled).toBe(true);
    expect(isr.data()).toBe("initial");
    expect(vi.getTimerCount()).toBe(0);

    await expect(isr.revalidate()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("an abort rejection during dispose schedules no retry", async () => {
    const fetcher = vi.fn(
      (ctx?: { signal: AbortSignal }) =>
        new Promise<string>((_, reject) => {
          ctx?.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const isr = createISR({ revalidateAfter: 1000, fetcher, initialData: "initial" });
    const p = isr.revalidate();
    isr.dispose();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
