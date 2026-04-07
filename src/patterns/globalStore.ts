import { derived } from "../core/signals/derived";
import { signal } from "../core/signals/signal";

// ============================================================================
// GLOBAL STATE MANAGEMENT
// ============================================================================

export type Middleware<S> = (state: S, action: string, payload: unknown, next: () => void) => void;

export type Selector<S, R> = (state: S) => R;

export interface GlobalStore<
  S extends Record<string, unknown>,
  A extends Record<string, (state: S, payload?: unknown) => Partial<S>>,
> {
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
export function globalStore<
  S extends Record<string, unknown>,
  A extends Record<string, (state: S, payload?: unknown) => Partial<S>>,
>(config: { state: S; actions: A; middleware?: Middleware<S>[] }): GlobalStore<S, A> {
  const initialState = { ...config.state };
  const [getState, setState] = signal<S>({ ...initialState });
  const listeners: Set<(state: S) => void> = new Set();
  const middlewares = config.middleware || [];

  function dispatch<K extends keyof A>(action: K, payload?: Parameters<A[K]>[1]): void {
    const actionFn = config.actions[action];
    if (!actionFn) throw new Error(`Unknown action: ${String(action)}`);

    const execute = () => {
      const current = getState();
      const rawPatch = actionFn(current, payload);
      // Strip prototype-pollution keys before merging to prevent __proto__ / constructor attacks
      const patch: Partial<S> = {};
      for (const key of Object.keys(rawPatch)) {
        if (key !== "__proto__" && key !== "constructor" && key !== "prototype") {
          (patch as Record<string, unknown>)[key] = (rawPatch as Record<string, unknown>)[key];
        }
      }
      setState({ ...current, ...patch } as S);
      // Notify listeners
      const newState = getState();
      for (const listener of listeners) {
        listener(newState);
      }
    };

    if (middlewares.length === 0) {
      execute();
      return;
    }

    // Run middleware chain
    let index = 0;
    const next = () => {
      if (index < middlewares.length) {
        const mw = middlewares[index++];
        mw(getState(), String(action), payload, next);
      } else {
        execute();
      }
    };
    next();
  }

  function select<R>(selector: Selector<S, R>): () => R {
    return derived(() => selector(getState()));
  }

  function subscribe(callback: (state: S) => void): () => void {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  function reset(): void {
    setState({ ...initialState } as S);
    for (const listener of listeners) {
      listener(getState());
    }
  }

  return { getState, select, dispatch, subscribe, reset };
}
