import { DEV, devWarn } from "../core/dev";
import { reportError } from "../core/errors";
import { signal } from "../core/signals/signal";
import { adoptThenable } from "../utils/adoptThenable";
import { stripUnsafeKeys } from "../utils/guards";

/**
 * Deep-clone a value, preserving Date / Map / Set / typed arrays via
 * `structuredClone` when available. Falls back to a recursive clone for
 * environments without it. Throws on circular references in the fallback.
 */
function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  const seen = new WeakSet<object>();
  const clone = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) throw new Error("deepClone: circular reference");
    seen.add(v as object);
    if (v instanceof Date) return new Date(v.getTime());
    if (v instanceof Map) {
      const out = new Map();
      for (const [k, val] of v) out.set(clone(k), clone(val));
      return out;
    }
    if (v instanceof Set) {
      const out = new Set();
      for (const val of v) out.add(clone(val));
      return out;
    }
    if (Array.isArray(v)) return v.map(clone);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      // Skip only `__proto__`: `out["__proto__"] = …` invokes the prototype
      // setter (pollution) rather than creating an own property. `constructor`
      // / `prototype` are ordinary own keys here, so cloning them is faithful
      // and safe — the dispatch-time filter is the security boundary for
      // untrusted patches. A faithful cloner must not drop legitimate data.
      if (k === "__proto__") continue;
      out[k] = clone((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return clone(value) as T;
}

// ============================================================================
// GLOBAL STATE MANAGEMENT
// ============================================================================

/**
 * Store middleware. Call `next()` once to continue the chain — synchronously or
 * later (after an `await`, from a timer). A middleware may be `async`: a
 * rejection is reported through the runtime error handler, and a middleware
 * that fails (throws, or rejects) before calling `next()` never continues —
 * a later `next()` from it is ignored.
 */
export type Middleware<S> = (state: S, action: string, payload: unknown, next: () => void) => void | PromiseLike<void>;

export type Selector<S, R> = (state: S) => R;

/**
 * Action-map constraint.
 *
 * `(state: S, payload?: unknown)` looks permissive but is the opposite: it
 * requires every action to ACCEPT any `unknown` payload, so a typed action such
 * as `add: (state, amount: number) => ...` is not assignable, and
 * `Parameters<A[K]>[1]` — which `dispatch` already uses to type its payload —
 * collapses to `unknown` for every action. The constraint therefore defeated the
 * per-action payload typing the rest of this file is built around.
 *
 * A `never[]` rest parameter accepts any concrete parameter list while keeping
 * `Parameters<A[K]>` intact, so `dispatch("add", 5)` is checked against the
 * action's real signature. (TYPE-007)
 */
export type StoreActionMap<S> = Record<string, (state: S, ...args: never[]) => Partial<S>>;

export interface GlobalStore<S extends object, A extends StoreActionMap<S>> {
  getState: () => S;
  select: <R>(selector: Selector<S, R>) => () => R;
  dispatch: <K extends keyof A>(action: K, payload?: Parameters<A[K]>[1]) => void;
  subscribe: (callback: (state: S) => void) => () => void;
  reset: () => void;
}

/**
 * globalStore creates a centralized state management store
 * with actions, selectors, and middleware support.
 */
export function globalStore<S extends object, A extends StoreActionMap<S>>(config: {
  state: S;
  actions: A;
  middleware?: Middleware<S>[];
}): GlobalStore<S, A> {
  const initialState = deepClone(config.state);
  const [getState, setState] = signal<S>({ ...initialState });
  // One record per subscription. Delivery snapshots RECORDS, not callbacks, so a
  // callback unsubscribed and re-subscribed during a round is a new record that
  // starts with the next update instead of passing for the old subscription.
  // Subscribing the same callback again while subscribed returns the existing
  // subscription (the previous Set semantics).
  interface Subscription {
    callback: (state: S) => void;
    active: boolean;
  }
  const subscriptions = new Map<(state: S) => void, Subscription>();
  const middlewares = config.middleware || [];

  /**
   * Deliver the committed state to every subscription that existed when the
   * round started. Each listener is isolated and its error reported; one
   * unsubscribed earlier in the round is skipped.
   */
  function notifyListeners(state: S): void {
    if (subscriptions.size === 0) return;
    for (const subscription of Array.from(subscriptions.values())) {
      if (!subscription.active) continue;
      try {
        subscription.callback(state);
      } catch (err) {
        reportError(err, { phase: "event", name: "globalStore(subscribe)" });
      }
    }
  }

  // Store operations (dispatch, reset) run to completion in call order. An
  // operation requested while another is running — from a listener, a
  // middleware or an action — is queued and runs after the current one has
  // committed AND delivered. Committing nested operations immediately let a
  // listener handling state N read state N+1 from getState(), and delivered
  // rounds out of order.
  const operations: Array<() => void> = [];
  let running = false;

  /**
   * Run `operation` through the queue. `rethrowOwn` decides what happens when
   * the operation itself throws: a direct dispatch()/reset() rethrows to its
   * caller; a delayed middleware continuation (a timer or promise) has no caller
   * to receive it, so its error is reported instead.
   */
  function perform(operation: () => void, rethrowOwn = true): void {
    operations.push(operation);
    if (running) return;
    running = true;
    let callerError: unknown;
    let callerFailed = false;
    try {
      let first = true;
      // A cursor, not shift(): shifting a growing array re-indexes it on every
      // step, which made a large reentrant burst quadratic.
      let cursor = 0;
      while (cursor < operations.length) {
        const next = operations[cursor];
        operations[cursor++] = undefined as unknown as () => void;
        try {
          next();
        } catch (err) {
          // The caller's own operation rethrows to the caller, as before; a
          // queued operation's caller has already returned, so it is reported.
          if (first && rethrowOwn) {
            callerFailed = true;
            callerError = err;
          } else {
            reportError(err, { phase: "event", name: "globalStore(dispatch)" });
          }
        }
        first = false;
      }
    } finally {
      // Release processed closures on every path.
      operations.length = 0;
      running = false;
    }
    if (callerFailed) throw callerError;
  }

  function dispatch<K extends keyof A>(action: K, payload?: Parameters<A[K]>[1]): void {
    const actionFn = config.actions[action];
    if (!actionFn) throw new Error(`Unknown action: ${String(action)}`);

    const execute = () => {
      const current = getState();
      // `A[K]` is constrained with a `never[]` rest parameter so that concrete
      // action signatures stay assignable and `Parameters<A[K]>` keeps their
      // real types. That makes the call site itself unprovable to the compiler,
      // which is unavoidable for a heterogeneous action map — the payload was
      // already checked against `Parameters<A[K]>[1]` at the `dispatch`
      // boundary, which is where it matters to callers.
      const rawPatch = (actionFn as unknown as (state: S, payload?: unknown) => Partial<S>)(current, payload);
      // Strip prototype-pollution keys before merging (shared guard).
      const patch = stripUnsafeKeys(rawPatch as Record<string, unknown>) as Partial<S>;
      setState({ ...current, ...patch } as S);
      notifyListeners(getState());
    };

    perform(() => {
      if (middlewares.length === 0) {
        execute();
        return;
      }

      // Run middleware chain. Each middleware receives its OWN `next`, usable
      // once. A single shared `next` over one index let a middleware that called
      // it twice run the action twice, and let the second call skip past every
      // middleware after it straight to the action.
      const runFrom = (index: number): void => {
        if (index >= middlewares.length) {
          execute();
          return;
        }
        let called = false;
        // Set when the middleware fails (throws, or its promise rejects) before
        // calling next(): its continuation is dead, so a later next() — from a
        // timer it scheduled, or after the rejection — never runs the action
        // that dispatch() already reported as failed.
        let failed = false;
        // True only while the middleware itself is running. A next() called
        // later — from a timer, a promise or after an await — runs after this
        // operation has left the queue, so it must re-enter through perform();
        // continuing directly let reentrant dispatches commit out of order again.
        let synchronous = true;
        const next = () => {
          if (failed && !called) {
            if (DEV)
              devWarn(
                `globalStore: middleware ${index} next() called after it failed for "${String(action)}"; ignored.`,
              );
            called = true;
            return;
          }
          if (called) {
            if (DEV)
              devWarn(
                `globalStore: middleware ${index} next() called more than once for "${String(action)}"; ignored.`,
              );
            return;
          }
          called = true;
          if (synchronous) runFrom(index + 1);
          else perform(() => runFrom(index + 1), false);
        };
        let pending: Promise<unknown> | null;
        try {
          // adoptThenable reads `then` once (a throwing getter becomes a
          // rejection) and invokes it in a later microtask.
          pending = adoptThenable(middlewares[index](getState(), String(action), payload, next));
        } catch (err) {
          failed = true;
          throw err;
        } finally {
          synchronous = false;
        }
        if (pending) {
          // Observed, so an async middleware failure reaches the runtime error
          // handler instead of becoming an unhandled rejection.
          pending.then(undefined, (err) => {
            failed = true;
            reportError(err, { phase: "async", name: "globalStore(middleware)" });
          });
        }
      };
      runFrom(0);
    });
  }

  function select<R>(selector: Selector<S, R>): () => R {
    // Return a plain reactive getter, not a standalone derived(): a derived
    // subscribes to the store for the app's lifetime, which leaks when select()
    // is called per-component. Reading getState() inside the CALLER's own
    // effect/derived ties the subscription to the caller's lifecycle instead,
    // and stays fully reactive.
    return () => selector(getState());
  }

  function subscribe(callback: (state: S) => void): () => void {
    let subscription = subscriptions.get(callback);
    if (!subscription) {
      subscription = { callback, active: true };
      subscriptions.set(callback, subscription);
    }
    const own = subscription;
    return () => {
      if (subscriptions.get(callback) !== own) return;
      own.active = false;
      subscriptions.delete(callback);
    };
  }

  function reset(): void {
    perform(() => {
      setState({ ...initialState } as S);
      notifyListeners(getState());
    });
  }

  return { getState, select, dispatch, subscribe, reset };
}
