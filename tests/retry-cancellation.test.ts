import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRetry } from "../src/data/retry";

// ---------------------------------------------------------------------------
// Cancellation beats retry policy.
//
// THE INVARIANT UNDER TEST: once an AbortSignal is aborted, the retry machinery
// stops immediately — no `shouldRetry` consultation, no `onRetry` callback, no
// backoff wait, no further attempt.
//
//   cancelled  !=  retryable failure
//
// Regression origin: the `catch` path had no `aborted` check, so an operation
// that rejected AFTER its signal was aborted was still treated as a retryable
// failure. Worse, the backoff promise registered its `abort` listener without
// first testing `signal.aborted` — and an AbortSignal does not replay a past
// `abort` event to a listener attached later. The listener therefore never
// fired and cancellation was delayed by the entire backoff (up to maxDelay).
// ---------------------------------------------------------------------------

/** A promise whose settlement this test controls exactly. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Attach a no-op catch so an intentionally-rejected deferred that the code
  // under test discards never surfaces as an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Let queued microtasks run without advancing fake timers. */
const microtasks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const LONG_BACKOFF = { maxRetries: 3, baseDelay: 30_000, maxDelay: 30_000, jitter: 0 } as const;

describe("abort wins over retry scheduling", () => {
  it("does not schedule a retry when the operation rejects after the signal aborted", async () => {
    // THE REGRESSION: abort lands while the request is in flight, then the
    // request rejects. That rejection is a consequence of the cancellation,
    // not an independent failure to retry.
    const controller = new AbortController();
    const d = deferred<string>();
    const fn = vi.fn(() => d.promise);
    const onRetry = vi.fn();

    const promise = withRetry(fn, LONG_BACKOFF, onRetry, controller.signal);
    promise.catch(() => {});
    await microtasks();
    expect(fn).toHaveBeenCalledTimes(1);

    controller.abort();
    d.reject(new Error("network failed"));
    await microtasks();

    // No retry may be scheduled for a cancelled operation.
    expect(onRetry).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
    // And no backoff timer may be pending.
    expect(vi.getTimerCount()).toBe(0);

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects promptly rather than after the full backoff", async () => {
    const controller = new AbortController();
    const d = deferred<string>();
    const onRetry = vi.fn();

    const promise = withRetry(() => d.promise, LONG_BACKOFF, onRetry, controller.signal);
    promise.catch(() => {});
    await microtasks();

    controller.abort();
    d.reject(new Error("network failed"));

    // Settled without advancing a single millisecond of the 30s backoff.
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not consult shouldRetry once the signal is aborted", async () => {
    const controller = new AbortController();
    const d = deferred<string>();
    const shouldRetry = vi.fn(() => true);

    const promise = withRetry(() => d.promise, { ...LONG_BACKOFF, shouldRetry }, undefined, controller.signal);
    promise.catch(() => {});
    await microtasks();

    controller.abort();
    d.reject(new Error("network failed"));
    await microtasks();

    expect(shouldRetry).not.toHaveBeenCalled();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts before the first attempt without invoking fn", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => "value");

    await expect(withRetry(fn, LONG_BACKOFF, undefined, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("aborts during the retry delay", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      throw new Error("network failed");
    });
    const onRetry = vi.fn();

    const promise = withRetry(fn, LONG_BACKOFF, onRetry, controller.signal);
    promise.catch(() => {});
    await microtasks();

    // First attempt failed while healthy, so a retry IS scheduled.
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();
    await microtasks();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(fn).toHaveBeenCalledTimes(1); // no second attempt
    expect(vi.getTimerCount()).toBe(0); // backoff timer cleared
  });

  it("aborts after the delay elapses but before the next attempt", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      throw new Error("network failed");
    });

    const promise = withRetry(fn, { ...LONG_BACKOFF, baseDelay: 10, maxDelay: 10 }, undefined, controller.signal);
    promise.catch(() => {});
    await microtasks();
    expect(fn).toHaveBeenCalledTimes(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(20);
    await microtasks();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("leaves no timer or listener behind after an abort", async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
    const fn = vi.fn(async () => {
      throw new Error("network failed");
    });

    const promise = withRetry(fn, { ...LONG_BACKOFF, baseDelay: 5_000 }, undefined, controller.signal);
    promise.catch(() => {});
    await microtasks();
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();
    await microtasks();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });

    expect(vi.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalled();
  });
});

describe("normal retry behaviour is unchanged", () => {
  it("retries a transient failure and resolves", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "recovered";
    });
    const onRetry = vi.fn();

    const promise = withRetry(fn, { maxRetries: 5, baseDelay: 10, maxDelay: 10, jitter: 0 }, onRetry);
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and rethrows the ORIGINAL error", async () => {
    const failure = new Error("permanent");
    const fn = vi.fn(async () => {
      throw failure;
    });

    const promise = withRetry(fn, { maxRetries: 2, baseDelay: 10, maxDelay: 10, jitter: 0 });
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("honours shouldRetry === false without retrying", async () => {
    const failure = new TypeError("not retryable");
    const fn = vi.fn(async () => {
      throw failure;
    });
    const onRetry = vi.fn();

    const promise = withRetry(
      fn,
      { maxRetries: 3, baseDelay: 10, maxDelay: 10, jitter: 0, shouldRetry: () => false },
      onRetry,
    );
    promise.catch(() => {});
    await microtasks();

    await expect(promise).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("works with no signal supplied", async () => {
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error("transient");
        return "ok";
      },
      { maxRetries: 2, baseDelay: 10, maxDelay: 10, jitter: 0 },
    );
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBe("ok");
  });
});
