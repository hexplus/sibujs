const nativeThen = Promise.prototype.then;

/**
 * One adoption of a thenable: the promise it settles, plus what that same
 * adoption can tell synchronously about the thenable's state.
 *
 * @internal
 */
export interface Adoption {
  /** Settles with the thenable, exactly as {@link adoptThenable} returns it. */
  readonly promise: Promise<unknown>;
  /** The adoption already failed: reading `then` threw. */
  readonly failedEarly: boolean;
  /**
   * Ask whether the thenable has ALREADY rejected, through the `then` this
   * adoption captured — never a second read of the property. Possible only when
   * that `then` is the native one, whose reaction on a settled promise is queued
   * at once: exactly one callback then runs, one microtask later. Returns
   * `false` (and calls neither) when the state cannot be read.
   */
  probe(onRejected: () => void, onOpen: () => void): boolean;
}

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
    return { promise: Promise.reject(error), failedEarly: true, probe: () => false };
  }
  if (typeof then !== "function") return null;
  const captured = then as (...args: unknown[]) => unknown;
  const promise = new Promise((resolve, reject) => {
    // Invoked in a later microtask, like native thenable assimilation, so the
    // caller finishes its synchronous setup (form.handleSubmit raises its
    // `submitting` lock) before any thenable code can re-enter it. Reflect.apply
    // avoids the function's own, overridable `call` property; the return value
    // of `then` is ignored.
    queueMicrotask(() => {
      try {
        Reflect.apply(captured, value, [resolve, reject]);
      } catch (error) {
        reject(error);
      }
    });
  });
  const probe = (onRejected: () => void, onOpen: () => void): boolean => {
    if (captured !== nativeThen) return false;
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
      return true;
    }
    queueMicrotask(() => decide(false));
    return true;
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
