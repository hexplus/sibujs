const nativeThen = Promise.prototype.then;

/**
 * One adoption of a thenable: the promise it settles, plus what that same
 * adoption knows about the thenable's state.
 *
 * @internal
 */
export interface Adoption {
  /** Settles with the thenable, exactly as {@link adoptThenable} returns it. */
  readonly promise: Promise<unknown>;
  /** The adoption already failed: reading `then` threw. */
  readonly failedEarly: boolean;
  /**
   * Decide whether the thenable has rejected, using only the `then` this
   * adoption captured — never a second read of the property. Exactly one
   * callback runs, never synchronously.
   *
   * - Native `then`: asked directly. Its reaction on a settled promise is queued
   *   at once, so this reports the promise's state at the time of the call.
   * - Any other `then`: decided by the adoption's own invocation of it (waiting
   *   for that invocation if it has not happened yet). A `then` that rejects
   *   synchronously, or throws, counts as rejected; one that fulfils, or has not
   *   settled yet, as open.
   */
  probe(onRejected: () => void, onOpen: () => void): void;
}

type AdoptionState = "pending-invocation" | "pending" | "resolved" | "rejected";

/**
 * Adopt `value` if it is a thenable, reading its `then` exactly once, and keep
 * that single read for later state probes. See {@link adoptThenable}.
 *
 * Returns `null` when `value` is not a thenable.
 *
 * @internal
 */
export function adopt(value: unknown): Adoption | null {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return null;
  let then: unknown;
  try {
    then = (value as { then?: unknown }).then;
  } catch (error) {
    return {
      promise: Promise.reject(error),
      failedEarly: true,
      probe: (onRejected) => queueMicrotask(onRejected),
    };
  }
  if (typeof then !== "function") return null;
  const captured = then as (...args: unknown[]) => unknown;

  // Tracked synchronously by the resolvers handed to the thenable, so the
  // adoption knows what its `then` reported the moment it returns.
  let state: AdoptionState = "pending-invocation";
  const afterInvocation: Array<() => void> = [];

  const promise = new Promise((resolve, reject) => {
    // Settle at most once, like the resolving functions they wrap.
    const adoptedResolve = (result: unknown) => {
      if (state === "resolved" || state === "rejected") return;
      state = "resolved";
      resolve(result);
    };
    const adoptedReject = (error: unknown) => {
      if (state === "resolved" || state === "rejected") return;
      state = "rejected";
      reject(error);
    };
    // Invoked in a later microtask, like native thenable assimilation, so the
    // caller finishes its synchronous setup (form.handleSubmit raises its
    // `submitting` lock) before any thenable code can re-enter it. Reflect.apply
    // avoids the function's own, overridable `call` property; the return value
    // of `then` is ignored.
    queueMicrotask(() => {
      try {
        Reflect.apply(captured, value, [adoptedResolve, adoptedReject]);
      } catch (error) {
        adoptedReject(error);
      }
      if (state === "pending-invocation") state = "pending";
      for (const waiter of afterInvocation.splice(0)) waiter();
    });
  });

  const probe = (onRejected: () => void, onOpen: () => void): void => {
    if (captured === nativeThen) {
      let decided = false;
      const decide = (rejected: boolean) => {
        if (decided) return;
        decided = true;
        (rejected ? onRejected : onOpen)();
      };
      try {
        Reflect.apply(captured, value, [undefined, () => decide(true)]);
      } catch {
        // The adoption's own invocation of this `then` throws the same way,
        // which rejects it.
        queueMicrotask(() => decide(true));
        return;
      }
      queueMicrotask(() => decide(false));
      return;
    }
    const decide = () => (state === "rejected" ? onRejected : onOpen)();
    if (state === "pending-invocation") afterInvocation.push(decide);
    else queueMicrotask(decide);
  };

  return { promise, failedEarly: false, probe };
}

/**
 * Adopt `value` as a promise if it is a thenable, reading its `then` exactly once.
 *
 * `typeof value.then === "function"` followed by `Promise.resolve(value)` reads
 * `then` twice, so a stateful accessor could pass the check and then hand the
 * promise machinery something else — skipping the operation or hiding its
 * rejection. Here `then` is read once and the captured function is invoked in a
 * later microtask (never synchronously, so callers can finish their own setup
 * first), with resolvers from a Promise that settles at most once; a throwing
 * invocation becomes a rejection.
 *
 * Returns `null` when `value` is not a thenable. A `then` accessor that throws
 * yields a rejected promise.
 *
 * @internal
 */
export function adoptThenable(value: unknown): Promise<unknown> | null {
  return adopt(value)?.promise ?? null;
}
