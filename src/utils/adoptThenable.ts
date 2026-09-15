/**
 * Adopt `value` as a promise if it is a thenable, reading its `then` exactly once.
 *
 * `typeof value.then === "function"` followed by `Promise.resolve(value)` reads
 * `then` twice, so a stateful accessor could pass the check and then hand the
 * promise machinery something else — skipping the operation or hiding its
 * rejection. Here the captured `then` is invoked through the Promise
 * constructor, which settles at most once and turns a throwing invocation into
 * a rejection.
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
    (then as (onFulfilled: (v: unknown) => void, onRejected: (e: unknown) => void) => unknown).call(
      value,
      resolve,
      reject,
    );
  });
}
