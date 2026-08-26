// Shared, strongly-typed test helpers.
//
// These exist because the same two shapes were being hand-rolled across the
// suite with types that either did not compile or quietly weakened the test.

/**
 * A one-slot holder for a callback captured from a mocked global.
 *
 * Solves two problems at once.
 *
 * TYPES: `let cb: FrameRequestCallback | null = null` assigned only inside a
 * `vi.stubGlobal` closure gets narrowed by control-flow analysis back to `null`
 * at every use site, so `cb?.(0)` fails to compile with "This expression is not
 * callable". TypeScript cannot see that the closure ran.
 *
 * VACUITY: the usual workaround, `cb?.(0)`, compiles but silently does nothing
 * when the mock never captured anything — the test then passes while exercising
 * none of the code it names. `invoke()` throws instead, so a mock that was never
 * wired up fails loudly.
 *
 * @example
 * const raf = callbackSlot<FrameRequestCallback>();
 * vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { raf.set(cb); return 1; });
 * scheduleUpdate(Priority.NORMAL, fn);
 * raf.invoke(0);           // throws if requestAnimationFrame was never called
 */
export interface CallbackSlot<F extends (...args: never[]) => unknown> {
  /** Store the captured callback. Pass directly as the mock body. */
  set: (fn: F) => void;
  /** The captured callback, or null. Prefer `invoke`/`captured` in assertions. */
  get: () => F | null;
  /** True once something has been captured. */
  captured: () => boolean;
  /** Invoke the captured callback, throwing if nothing was ever captured. */
  invoke: (...args: Parameters<F>) => ReturnType<F>;
}

export function callbackSlot<F extends (...args: never[]) => unknown>(name = "callback"): CallbackSlot<F> {
  let current: F | null = null;
  return {
    set: (fn: F) => {
      current = fn;
    },
    get: () => current,
    captured: () => current !== null,
    invoke: (...args: Parameters<F>): ReturnType<F> => {
      if (current === null) {
        throw new Error(
          `${name} was invoked but never captured — the mocked global was not called, so this assertion proves nothing.`,
        );
      }
      return current(...args) as ReturnType<F>;
    },
  };
}

/**
 * A promise plus its settle functions, with both correctly typed.
 *
 * The hand-rolled version — `let resolve; const p = new Promise(r => { resolve = r })`
 * — trips `TS2454: Variable 'resolve' is used before being assigned`, because
 * TypeScript cannot see that the executor runs synchronously. The usual patches
 * (a non-null assertion, or typing it `any`) either lie or discard the payload
 * type, which matters: these deferreds gate query/router/SSR async tests, and a
 * mistyped `resolve` silently accepts the wrong value.
 */
export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  /** True once resolve or reject has been called. */
  settled: () => boolean;
}

export function createDeferred<T = void>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (reason?: unknown) => void;
  let isSettled = false;

  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  return {
    promise,
    resolve: (value: T) => {
      isSettled = true;
      resolveFn(value);
    },
    reject: (reason?: unknown) => {
      isSettled = true;
      rejectFn(reason);
    },
    settled: () => isSettled,
  };
}
