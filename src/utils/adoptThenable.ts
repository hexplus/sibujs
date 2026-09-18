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
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return null;
  let then: unknown;
  try {
    then = (value as { then?: unknown }).then;
  } catch (error) {
    return Promise.reject(error);
  }
  if (typeof then !== "function") return null;
  return new Promise((resolve, reject) => {
    // Invoked in a later microtask, like native thenable assimilation, so the
    // caller finishes its synchronous setup (form.handleSubmit raises its
    // `submitting` lock) before any thenable code can re-enter it. Reflect.apply
    // avoids the function's own, overridable `call` property; the return value
    // of `then` is ignored.
    queueMicrotask(() => {
      try {
        Reflect.apply(then as (...args: unknown[]) => unknown, value, [resolve, reject]);
      } catch (error) {
        reject(error);
      }
    });
  });
}
