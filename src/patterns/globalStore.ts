import { DEV, devWarn } from "../core/dev";
import { reportError } from "../core/errors";
import { signal } from "../core/signals/signal";
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

export type Middleware<S> = (state: S, action: string, payload: unknown, next: () => void) => void;

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
  const listeners: Set<(state: S) => void> = new Set();
  const middlewares = config.middleware || [];

  /**
   * Deliver a committed state to every listener.
   *
   * State is already committed when this runs, so a listener failure must not
   * look like a failed dispatch or cost the listeners after it the update: each
   * one is isolated and its error reported. Delivery walks a snapshot, so a
   * listener subscribed during notification starts with the NEXT update —
   * iterating the live Set would run it now, and a listener that subscribes on
   * every call would keep iteration from terminating. A listener unsubscribed
   * by an earlier one in the same round is skipped.
   */
  // Notification rounds run to completion in commit order. A listener that
  // dispatches (or resets) during a round queues the new state's round behind
  // the current one; nesting it delivered the newer state first and then resumed
  // the older round, so listeners saw history backwards.
  const pendingRounds: S[] = [];
  let draining = false;

  function notifyListeners(state: S): void {
    pendingRounds.push(state);
    if (draining) return;
    draining = true;
    try {
      while (pendingRounds.length > 0) {
        const roundState = pendingRounds.shift() as S;
        if (listeners.size === 0) continue;
        const snapshot = Array.from(listeners);
        for (const listener of snapshot) {
          if (!listeners.has(listener)) continue;
          try {
            listener(roundState);
          } catch (err) {
            reportError(err, { phase: "event", name: "globalStore(subscribe)" });
          }
        }
      }
    } finally {
      draining = false;
    }
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
      const next = () => {
        if (called) {
          if (DEV)
            devWarn(`globalStore: middleware ${index} next() called more than once for "${String(action)}"; ignored.`);
          return;
        }
        called = true;
        runFrom(index + 1);
      };
      middlewares[index](getState(), String(action), payload, next);
    };
    runFrom(0);
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
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  function reset(): void {
    setState({ ...initialState } as S);
    notifyListeners(getState());
  }

  return { getState, select, dispatch, subscribe, reset };
}
