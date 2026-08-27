import { describe, expect, it, vi } from "vitest";
import { mutation } from "../src/data/mutation";

// ---------------------------------------------------------------------------
// A cancelled mutation must still REACH a terminal state.
//
// THE INVARIANT UNDER TEST:
//
//   CURRENT RUN                        STALE RUN
//     success  → success state           success  ─┐
//     failure  → error state             failure  ─┼→ never overwrites
//     cancel   → terminal NON-error      cancel   ─┘   the current run
//
// Cancellation is control flow, not failure — but "not a failure" was
// implemented as "not my problem". `execute()` set `loading = true` /
// `status = "loading"` up front, and the AbortError branch rethrew before any
// terminal transition ran. When the cancellation belonged to `reset()` or to a
// superseding `mutate()` that was harmless, because those paths write the state
// themselves. When the CURRENT run's own `mutationFn` rejected an AbortError,
// nothing else was coming: the promise rejected and the mutation stayed
// permanently pending — a spinner bound to `loading()` never stopped.
//
// The repair has to be run-owned. A blanket `finally { setLoading(false) }`
// would let a late, superseded run clear the loading state of the newer run
// that legitimately owns it.
//
// CHOSEN CANCELLATION SEMANTICS (non-destructive restoration): a cancelled
// current run restores the externally observable state that existed just before
// it started. Cancelling did not invalidate the previous result, so
// `success(data)` stays `success(data)` and `error(E)` stays `error(E)`. Only
// `status` and `error` are snapshotted — `execute()` does not touch `data` at
// start, so there is nothing else to restore.
// ---------------------------------------------------------------------------

/** A promise whose settlement this test controls exactly. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** Every carrier shape the shared classifier accepts. */
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

/**
 * `status` is not public, so it is asserted through the getters that project
 * it. A permanently pending mutation shows up here as `loading() === true`
 * after the returned promise has already settled.
 */
function expectNotPending(m: { loading: () => boolean }) {
  expect(m.loading()).toBe(false);
}

describe("current-run cancellation reaches a terminal state", () => {
  for (const [label, make] of ABORT_SHAPES) {
    it(`${label}: mutateAsync leaves the loading state`, async () => {
      const onError = vi.fn();
      const thrown = make();
      const m = mutation(
        async () => {
          throw thrown;
        },
        { onError },
      );

      // THE REGRESSION: before the fix this rejected correctly and then left
      // loading() === true forever.
      await expect(m.mutateAsync(undefined as never)).rejects.toBe(thrown);

      expectNotPending(m);
      expect(m.isIdle()).toBe(true);
      expect(m.error()).toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
    });

    it(`${label}: state is already terminal when the caller catches`, async () => {
      // Ordering matters: the caller must not observe a pending mutation in the
      // rejection handler it was just handed.
      const thrown = make();
      const m = mutation(async () => {
        throw thrown;
      });

      let loadingAtRejection: boolean | null = null;
      await m.mutateAsync(undefined as never).catch(() => {
        loadingAtRejection = m.loading();
      });

      expect(loadingAtRejection).toBe(false);
    });

    it(`${label}: fire-and-forget mutate leaves loading and does not warn`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const onError = vi.fn();
      const thrown = make();
      const m = mutation(
        async () => {
          throw thrown;
        },
        { onError },
      );

      m.mutate(undefined as never);
      await settle();

      expectNotPending(m);
      expect(m.isIdle()).toBe(true);
      expect(m.error()).toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it(`${label}: bypasses retry policy and invokes mutationFn once`, async () => {
      // Deliberately a retrying configuration, and a `shouldRetry` that would
      // approve anything — so a single invocation proves cancellation skipped
      // the policy rather than the policy happening to decline.
      //
      // `onRetry` needs no assertion here: `mutation()` passes `undefined` for
      // it, so it is structurally unreachable. The withRetry-level guarantee is
      // pinned directly in tests/cancellation-precedence.test.ts.
      let calls = 0;
      const shouldRetry = vi.fn(() => true);
      const thrown = make();
      const m = mutation(
        async () => {
          calls++;
          throw thrown;
        },
        { retry: { maxRetries: 3, baseDelay: 5, maxDelay: 5, jitter: 0, shouldRetry } },
      );

      await expect(m.mutateAsync(undefined as never)).rejects.toBe(thrown);
      await settle();
      expect(calls).toBe(1);
      expect(shouldRetry).not.toHaveBeenCalled();
      expectNotPending(m);
    });
  }
});

describe("cancellation restores the state the run replaced", () => {
  it("idle → cancel → idle", async () => {
    const m = mutation(async () => {
      throw new DOMException("Aborted", "AbortError");
    });

    expect(m.isIdle()).toBe(true);
    await expect(m.mutateAsync(undefined as never)).rejects.toMatchObject({ name: "AbortError" });

    expect(m.isIdle()).toBe(true);
    expect(m.loading()).toBe(false);
    expect(m.error()).toBeUndefined();
    expect(m.data()).toBeUndefined();
  });

  it("success(data) → cancel → success(data)", async () => {
    // Cancelling a NEW mutation did not invalidate the OLD result.
    let mode: "ok" | "cancel" = "ok";
    const m = mutation(async () => {
      if (mode === "cancel") throw new DOMException("Aborted", "AbortError");
      return "old";
    });

    await m.mutateAsync(undefined as never);
    expect(m.data()).toBe("old");
    expect(m.isSuccess()).toBe(true);

    mode = "cancel";
    await expect(m.mutateAsync(undefined as never)).rejects.toMatchObject({ name: "AbortError" });

    expect(m.data()).toBe("old");
    expect(m.isSuccess()).toBe(true);
    expect(m.loading()).toBe(false);
    expect(m.error()).toBeUndefined();
  });

  it("error(E) → cancel → error(E)", async () => {
    const failure = new Error("original failure");
    let mode: "fail" | "cancel" = "fail";
    const m = mutation(
      async () => {
        if (mode === "cancel") throw new DOMException("Aborted", "AbortError");
        throw failure;
      },
      { retry: { maxRetries: 0 } },
    );

    await expect(m.mutateAsync(undefined as never)).rejects.toBe(failure);
    expect(m.error()).toBe(failure);

    mode = "cancel";
    await expect(m.mutateAsync(undefined as never)).rejects.toMatchObject({ name: "AbortError" });

    // The cancelled attempt produced no verdict of its own, so the previous
    // one still stands. It is NOT downgraded to idle.
    expect(m.error()).toBe(failure);
    expect(m.isIdle()).toBe(false);
    expect(m.isSuccess()).toBe(false);
    expect(m.loading()).toBe(false);
  });
});

describe("a stale run never writes the current run's state", () => {
  it("a superseded run aborting late leaves the newer run loading", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const calls: Array<"a" | "b"> = [];
    const m = mutation(async () => {
      const which = calls.length === 0 ? "a" : "b";
      calls.push(which);
      return which === "a" ? a.promise : b.promise;
    });

    const pa = m.mutateAsync(undefined as never);
    pa.catch(() => {});
    await settle();
    expect(m.loading()).toBe(true);

    // B supersedes A and becomes the current run.
    const pb = m.mutateAsync(undefined as never);
    pb.catch(() => {});
    await settle();
    expect(m.loading()).toBe(true);

    // A now rejects with the abort B caused. A is stale — it owns nothing.
    a.reject(new DOMException("Aborted", "AbortError"));
    await expect(pa).rejects.toMatchObject({ name: "AbortError" });
    await settle();

    // THE TRAP a blanket `finally { setLoading(false) }` would fall into.
    expect(m.loading()).toBe(true);
    expect(m.isIdle()).toBe(false);
    expect(m.error()).toBeUndefined();

    // B still owns the outcome.
    b.resolve("from-b");
    await expect(pb).resolves.toBe("from-b");
    expect(m.data()).toBe("from-b");
    expect(m.isSuccess()).toBe(true);
    expect(m.loading()).toBe(false);
  });

  it("a run aborted by reset() cannot overwrite the idle state", async () => {
    const a = deferred<string>();
    const m = mutation(async () => a.promise);

    const pa = m.mutateAsync(undefined as never);
    pa.catch(() => {});
    await settle();
    expect(m.loading()).toBe(true);

    m.reset();
    expect(m.isIdle()).toBe(true);
    expect(m.loading()).toBe(false);

    a.reject(new DOMException("Aborted", "AbortError"));
    await expect(pa).rejects.toMatchObject({ name: "AbortError" });
    await settle();

    expect(m.isIdle()).toBe(true);
    expect(m.loading()).toBe(false);
    expect(m.error()).toBeUndefined();
    expect(m.data()).toBeUndefined();
  });

  it("a stale run's ordinary failure still cannot overwrite the current run", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    let n = 0;
    const m = mutation(async () => (n++ === 0 ? a.promise : b.promise), { retry: { maxRetries: 0 } });

    const pa = m.mutateAsync(undefined as never);
    pa.catch(() => {});
    await settle();
    const pb = m.mutateAsync(undefined as never);
    pb.catch(() => {});
    await settle();

    // A's signal was aborted the moment B superseded it, so cancellation
    // outranks A's own failure and A rejects as an AbortError. Either way it is
    // stale and may not write state.
    a.reject(new Error("stale failure"));
    await expect(pa).rejects.toMatchObject({ name: "AbortError" });
    await settle();

    expect(m.error()).toBeUndefined();
    expect(m.loading()).toBe(true);

    b.resolve("from-b");
    await pb;
    expect(m.isSuccess()).toBe(true);
  });
});

describe("non-cancellation outcomes are unchanged", () => {
  it("an ordinary failure still produces error state and calls onError", async () => {
    const onError = vi.fn();
    const onSettled = vi.fn();
    const failure = new Error("real failure");
    const m = mutation(
      async () => {
        throw failure;
      },
      { onError, onSettled, retry: { maxRetries: 0 } },
    );

    await expect(m.mutateAsync(undefined as never)).rejects.toBe(failure);

    expect(m.error()).toBe(failure);
    expect(m.loading()).toBe(false);
    expect(m.isIdle()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("a success still produces success state", async () => {
    const onSuccess = vi.fn();
    const m = mutation(async () => "ok", { onSuccess });

    await expect(m.mutateAsync(undefined as never)).resolves.toBe("ok");

    expect(m.data()).toBe("ok");
    expect(m.isSuccess()).toBe(true);
    expect(m.loading()).toBe(false);
    expect(m.error()).toBeUndefined();
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("cancellation is not a settle notification", () => {
  // Pins the EXISTING contract: the AbortError branch rethrows ahead of both
  // callbacks, so a cancelled mutation notifies neither. Cancellation is the
  // absence of an outcome, not an outcome to report.
  for (const [label, make] of ABORT_SHAPES) {
    it(`${label}: calls neither onError nor onSettled`, async () => {
      const onError = vi.fn();
      const onSettled = vi.fn();
      const onSuccess = vi.fn();
      const thrown = make();
      const m = mutation(
        async () => {
          throw thrown;
        },
        { onError, onSettled, onSuccess },
      );

      await expect(m.mutateAsync(undefined as never)).rejects.toBe(thrown);
      await settle();

      expect(onError).not.toHaveBeenCalled();
      expect(onSettled).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
    });
  }
});

describe("onMutate follows the same cancellation semantics as mutationFn", () => {
  // CHOSEN CONTRACT: `isAbortError()` is authoritative for the whole operation.
  // An ordinary `onMutate` exception fails the mutation; an AbortError from
  // `onMutate` is cancellation, exactly as from `mutationFn`.
  it("an ordinary onMutate exception still fails the mutation", async () => {
    const onError = vi.fn();
    const failure = new Error("onMutate failed");
    const fn = vi.fn(async () => "never");
    const m = mutation(fn, {
      onMutate: () => {
        throw failure;
      },
      onError,
      retry: { maxRetries: 0 },
    });

    await expect(m.mutateAsync(undefined as never)).rejects.toBe(failure);

    expect(m.error()).toBe(failure);
    expect(m.loading()).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it("an AbortError from onMutate is cancellation, not failure", async () => {
    const onError = vi.fn();
    const abortError = new DOMException("Aborted", "AbortError");
    const fn = vi.fn(async () => "never");
    const m = mutation(fn, {
      onMutate: () => {
        throw abortError;
      },
      onError,
    });

    await expect(m.mutateAsync(undefined as never)).rejects.toBe(abortError);

    expect(m.loading()).toBe(false);
    expect(m.isIdle()).toBe(true);
    expect(m.error()).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancellation after onMutate produced context does not call onError", async () => {
    const onError = vi.fn();
    const m = mutation(
      async () => {
        throw new DOMException("Aborted", "AbortError");
      },
      { onMutate: () => ({ rollback: true }), onError },
    );

    await expect(m.mutateAsync(undefined as never)).rejects.toMatchObject({ name: "AbortError" });
    expect(onError).not.toHaveBeenCalled();
    expect(m.loading()).toBe(false);
  });
});

describe("cancellation interacts correctly with retry policy", () => {
  it("an AbortError on attempt 2 stops retrying and leaves loading", async () => {
    const shouldRetry = vi.fn(() => true);
    const abortError = new DOMException("Aborted", "AbortError");
    let attempts = 0;

    const m = mutation(
      async () => {
        attempts++;
        if (attempts === 1) throw new Error("transient");
        throw abortError;
      },
      { retry: { maxRetries: 5, baseDelay: 1, maxDelay: 1, jitter: 0, shouldRetry } },
    );

    await expect(m.mutateAsync(undefined as never)).rejects.toBe(abortError);
    await settle();

    expect(attempts).toBe(2); // no attempt 3
    // shouldRetry was asked about the ordinary failure only.
    expect(shouldRetry).toHaveBeenCalledTimes(1);
    expect(m.loading()).toBe(false);
    expect(m.isIdle()).toBe(true);
    expect(m.error()).toBeUndefined();
  });

  it("reset() during a retry delay cancels without a further attempt", async () => {
    let attempts = 0;
    const m = mutation(
      async () => {
        attempts++;
        throw new Error("transient");
      },
      { retry: { maxRetries: 5, baseDelay: 10_000, maxDelay: 10_000, jitter: 0 } },
    );

    const p = m.mutateAsync(undefined as never);
    p.catch(() => {});
    await settle();
    expect(attempts).toBe(1);
    expect(m.loading()).toBe(true);

    m.reset();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    await settle();

    expect(attempts).toBe(1); // the backoff never elapsed into attempt 2
    // reset() owns the state; the stale run left it alone.
    expect(m.isIdle()).toBe(true);
    expect(m.loading()).toBe(false);
    expect(m.error()).toBeUndefined();
  });
});
