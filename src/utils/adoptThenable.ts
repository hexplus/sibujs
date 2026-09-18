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
   * Decide whether the adoption has failed, using only the `then` functions it
   * captured — never a second read of a property. Exactly one callback runs,
   * never synchronously.
   *
   * The adoption follows the resolution chain itself (a thenable resolving to a
   * thenable resolving to a promise …), so the decision waits until the chain
   * reaches a stable point, however deep it is:
   * - a terminal value or rejection: open or rejected;
   * - a foreign `then` that was invoked and reported nothing, even in the
   *   reaction a promise-backed `then` queues for an already-settled state:
   *   genuinely pending, so open. A `then` that holds back a known state for
   *   several microtasks cannot be told apart from a pending one;
   * - a native promise: asked directly through its native `then`, whose reaction
   *   on a settled promise is queued at once — so a rejection that happened
   *   before this call is reported, one that happens after it is not.
   */
  probe(onRejected: () => void, onOpen: () => void): void;
}

/**
 * Where the resolution chain stands.
 * - `invoking`: a foreign `then` is queued for invocation; not known yet.
 * - `pending`: that `then` was invoked and reported nothing.
 * - `native`: the chain currently rests on a native promise.
 * - `fulfilled` / `rejected`: terminal.
 */
type ChainState = "invoking" | "pending" | "native" | "fulfilled" | "rejected";

/** Ask a native promise whether it has already rejected; see {@link Adoption.probe}. */
function probeNative(target: unknown, onRejected: () => void, onOpen: () => void): void {
  let decided = false;
  const decide = (rejected: boolean) => {
    if (decided) return;
    decided = true;
    (rejected ? onRejected : onOpen)();
  };
  try {
    Reflect.apply(nativeThen, target, [undefined, () => decide(true)]);
  } catch {
    // The adoption's own invocation of this `then` throws the same way, which
    // rejects it.
    queueMicrotask(() => decide(true));
    return;
  }
  queueMicrotask(() => decide(false));
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
    return {
      promise: Promise.reject(error),
      failedEarly: true,
      probe: (onRejected) => queueMicrotask(onRejected),
    };
  }
  if (typeof then !== "function") return null;

  let resolvePromise!: (result: unknown) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  let state: ChainState = "invoking";
  let nativeTarget: unknown;
  const waiters: Array<() => void> = [];
  const transition = (next: ChainState) => {
    state = next;
    if (next === "invoking") return;
    for (const waiter of waiters.splice(0)) waiter();
  };
  const fulfil = (result: unknown) => {
    resolvePromise(result);
    transition("fulfilled");
  };
  const fail = (error: unknown) => {
    rejectPromise(error);
    transition("rejected");
  };

  // The promise resolution procedure, run here rather than delegated to a
  // native resolve(): delegating hid a nested thenable's assimilation, so the
  // chain looked settled while it could still reject.
  const follow = (result: unknown): void => {
    if (result === promise) {
      fail(new TypeError("adoptThenable: a thenable resolved to its own adoption"));
      return;
    }
    if (result === null || (typeof result !== "object" && typeof result !== "function")) {
      fulfil(result);
      return;
    }
    let nextThen: unknown;
    try {
      nextThen = (result as { then?: unknown }).then;
    } catch (error) {
      fail(error);
      return;
    }
    if (typeof nextThen !== "function") {
      fulfil(result);
      return;
    }
    invokeLater(result, nextThen as (...args: unknown[]) => unknown);
  };

  // Invoked in a later microtask, like native thenable assimilation, so the
  // caller finishes its synchronous setup (form.handleSubmit raises its
  // `submitting` lock) before any thenable code can re-enter it. Each invocation
  // gets its own resolvers, usable once. Reflect.apply avoids the function's
  // own, overridable `call` property; the return value of `then` is ignored.
  const invokeLater = (target: unknown, targetThen: (...args: unknown[]) => unknown): void => {
    if (targetThen === nativeThen) {
      nativeTarget = target;
      transition("native");
    } else {
      transition("invoking");
    }
    queueMicrotask(() => {
      let done = false;
      const onResolve = (result: unknown) => {
        if (done) return;
        done = true;
        follow(result);
      };
      const onReject = (error: unknown) => {
        if (done) return;
        done = true;
        fail(error);
      };
      try {
        Reflect.apply(targetThen, target, [onResolve, onReject]);
      } catch (error) {
        onReject(error);
      }
      if (!done && state === "invoking") {
        // Reported nothing synchronously — but a promise-backed `then` (a
        // wrapped or subclassed promise, a cross-realm one) delivers even an
        // already-settled state through a reaction it just queued. Decide one
        // microtask later, after that reaction, and only if the chain has not
        // moved on meanwhile; a genuinely pending thenable is still pending.
        state = "pending";
        queueMicrotask(() => {
          if (state === "pending") transition("pending");
        });
      }
    });
  };

  invokeLater(value, then as (...args: unknown[]) => unknown);

  const probe = (onRejected: () => void, onOpen: () => void): void => {
    const decide = () => {
      if (state === "native") probeNative(nativeTarget, onRejected, onOpen);
      else (state === "rejected" ? onRejected : onOpen)();
    };
    // A native promise is asked NOW, so its answer reflects the moment of the
    // call; an unresolved foreign step is waited for; anything else is known.
    // A queued decide() runs after any reaction a promise-backed `then` already
    // queued, so a `pending` state is re-read once those have had their turn.
    if (state === "native") probeNative(nativeTarget, onRejected, onOpen);
    else if (state === "invoking") waiters.push(decide);
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
