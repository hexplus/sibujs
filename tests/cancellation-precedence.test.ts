import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mutation } from "../src/data/mutation";
import { resource } from "../src/data/resource";
import { withRetry } from "../src/data/retry";

// ---------------------------------------------------------------------------
// Cancellation precedence: the REJECTED VALUE counts, not just the signal.
//
// THE INVARIANT UNDER TEST:
//
//   signal aborted  OR  rejected value is an AbortError
//         ↓
//       CANCEL — no shouldRetry, no onRetry, no timer, no next attempt
//
// PR #55 fixed the `signal.aborted` half and gave the data layer a shared
// `isAbortError()`. But `withRetry` only ever consulted `signal?.aborted`, so a
// fetcher that rejects with an AbortError WITHOUT its signal being aborted —
// or with no signal at all — still walked into retry policy: `shouldRetry` was
// asked, `onRetry` fired, a backoff was scheduled, and the cancelled operation
// was attempted again.
//
// `mutation` had the mirror-image bug: it normalised the thrown value into an
// `Error` BEFORE classifying it, so a plain `{ name: "AbortError" }` became
// `new Error("[object Object]")` with `name === "Error"` — cancellation
// identity destroyed before anything could recognise it.
// ---------------------------------------------------------------------------

/** Let queued microtasks run without advancing fake timers. */
const microtasks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** Every carrier shape `isAbortError()` supports. */
const ABORT_SHAPES: [string, () => unknown][] = [
  ["DOMException", () => new DOMException("Aborted", "AbortError")],
  [
    "ordinary Error",
    () => {
      const e = new Error("cancelled");
      e.name = "AbortError";
      return e;
    },
  ],
  ["plain object", () => ({ name: "AbortError", message: "cancelled" })],
];

describe("withRetry: an AbortError rejection is cancellation, signal or not", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const [label, make] of ABORT_SHAPES) {
    it(`${label}: bypasses retry entirely with DEFAULT retry configuration`, async () => {
      // Deliberately NOT maxRetries: 0 — that would bypass the code under test.
      const thrown = make();
      const fn = vi.fn(async () => {
        throw thrown;
      });
      const shouldRetry = vi.fn(() => true);
      const onRetry = vi.fn();

      const promise = withRetry(fn, { maxRetries: 3, baseDelay: 30_000, jitter: 0, shouldRetry }, onRetry);
      promise.catch(() => {});
      await microtasks();

      // Cancellation never enters retry policy.
      expect(fn).toHaveBeenCalledTimes(1);
      expect(shouldRetry).not.toHaveBeenCalled();
      expect(onRetry).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    });

    it(`${label}: propagates the ORIGINAL value, not a substitute`, async () => {
      const thrown = make();
      const promise = withRetry(
        async () => {
          throw thrown;
        },
        { maxRetries: 3, baseDelay: 30_000, jitter: 0 },
      );
      await expect(promise).rejects.toBe(thrown);
    });
  }

  it("an unaborted signal does not make an AbortError retryable", async () => {
    const controller = new AbortController();
    const onRetry = vi.fn();
    const abortError = new Error("cancelled");
    abortError.name = "AbortError";

    const fn = vi.fn(async () => {
      throw abortError;
    });
    const promise = withRetry(fn, { maxRetries: 3, baseDelay: 30_000, jitter: 0 }, onRetry, controller.signal);
    promise.catch(() => {});
    await microtasks();

    expect(controller.signal.aborted).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    await expect(promise).rejects.toBe(abortError);
  });
});

describe("withRetry: full cancellation precedence cross-product", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const RETRY_OPTS = { maxRetries: 3, baseDelay: 10, maxDelay: 10, jitter: 0 } as const;

  it("signal aborted + normal Error → cancel", async () => {
    const controller = new AbortController();
    const onRetry = vi.fn();
    const fn = vi.fn(async () => {
      controller.abort();
      throw new Error("network failed");
    });

    const promise = withRetry(fn, RETRY_OPTS, onRetry, controller.signal);
    promise.catch(() => {});
    await microtasks();

    expect(onRetry).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("signal aborted + AbortError → cancels exactly once", async () => {
    const controller = new AbortController();
    const onRetry = vi.fn();
    const fn = vi.fn(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });

    const promise = withRetry(fn, RETRY_OPTS, onRetry, controller.signal);
    promise.catch(() => {});
    await microtasks();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("no signal + AbortError → cancel", async () => {
    const abortError = new DOMException("Aborted", "AbortError");
    const onRetry = vi.fn();
    const fn = vi.fn(async () => {
      throw abortError;
    });

    const promise = withRetry(fn, RETRY_OPTS, onRetry);
    promise.catch(() => {});
    await microtasks();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    await expect(promise).rejects.toBe(abortError);
  });

  it("no signal + normal Error → ordinary retry behaviour survives", async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const promise = withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "recovered";
      },
      RETRY_OPTS,
      onRetry,
    );
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.toBe("recovered");
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("a message mentioning AbortError is still an ordinary failure", async () => {
    // Classification is by `name`, never by message.
    const failure = new Error("AbortError");
    expect(failure.name).toBe("Error");
    const onRetry = vi.fn();
    const fn = vi.fn(async () => {
      throw failure;
    });

    const promise = withRetry(fn, RETRY_OPTS, onRetry);
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledTimes(4); // initial + 3 retries
    expect(onRetry).toHaveBeenCalledTimes(3);
  });
});

describe("resource(): an AbortError loader failure does not retry", () => {
  it("runs the loader once and records no error state", async () => {
    const onError = vi.fn();
    const abortError = new Error("cancelled");
    abortError.name = "AbortError";

    let calls = 0;
    // Default retry config — NOT maxRetries: 0.
    const res = resource(
      async () => {
        calls++;
        throw abortError;
      },
      { onError, retry: { maxRetries: 3, baseDelay: 5, maxDelay: 5, jitter: 0 } },
    );

    await new Promise((r) => setTimeout(r, 60));

    expect(calls).toBe(1);
    expect(res.error()).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("mutation(): classification happens before normalization", () => {
  for (const [label, make] of ABORT_SHAPES) {
    it(`${label}: mutateAsync treats it as cancellation, not error state`, async () => {
      const onError = vi.fn();
      const thrown = make();
      const m = mutation(
        async () => {
          throw thrown;
        },
        { onError, retry: { maxRetries: 3, baseDelay: 5, maxDelay: 5, jitter: 0 } },
      );

      await expect(m.mutateAsync(undefined as never)).rejects.toMatchObject({ name: "AbortError" });
      await new Promise((r) => setTimeout(r, 40));

      // Cancellation is control flow: no application error state, no onError.
      expect(m.error()).toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
    });

    it(`${label}: fire-and-forget mutate does not warn or set error state`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const onError = vi.fn();
      const thrown = make();
      const m = mutation(
        async () => {
          throw thrown;
        },
        { onError, retry: { maxRetries: 3, baseDelay: 5, maxDelay: 5, jitter: 0 } },
      );

      m.mutate(undefined as never);
      await new Promise((r) => setTimeout(r, 40));

      expect(m.error()).toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
      expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).not.toContain("mutate() failed");
      warn.mockRestore();
    });
  }

  it("calls the mutation function exactly once for an AbortError", async () => {
    let calls = 0;
    const abortError = new DOMException("Aborted", "AbortError");
    const m = mutation(
      async () => {
        calls++;
        throw abortError;
      },
      { retry: { maxRetries: 3, baseDelay: 5, maxDelay: 5, jitter: 0 } },
    );

    await expect(m.mutateAsync(undefined as never)).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(1);
  });

  it("an ordinary failure still becomes error state", async () => {
    const onError = vi.fn();
    const failure = new Error("real failure");
    const m = mutation(
      async () => {
        throw failure;
      },
      { onError, retry: { maxRetries: 0 } },
    );

    await expect(m.mutateAsync(undefined as never)).rejects.toBe(failure);
    await new Promise((r) => setTimeout(r, 20));

    expect(m.error()).toBe(failure);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
