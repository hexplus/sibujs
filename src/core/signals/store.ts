import { batch } from "../../reactivity/batch";
import { devAssert } from "../dev";
import { effect } from "./effect";
import { signal } from "./signal";

type StoreSubscriber<T> = (state: T) => void;

export interface StoreActions<T> {
  /** Apply a partial patch or updater function */
  setState: (patch: Partial<T> | ((state: T) => T)) => void;
  /** Revert to initial state */
  reset: () => void;
  /** Subscribe to all state changes. Returns unsubscribe function. */
  subscribe: (callback: StoreSubscriber<T>) => () => void;
  /** Subscribe to changes on a specific key. Returns unsubscribe function. */
  subscribeKey: <K extends keyof T>(key: K, callback: (value: T[K], prev: T[K]) => void) => () => void;
  /** Get a snapshot of the current state (non-reactive) */
  getSnapshot: () => T;
}

/**
 * Creates a global store with reactive properties and subscription support.
 *
 * @param initialState Initial state object
 * @returns A tuple [store, actions]
 *
 * @example
 * ```ts
 * const [store, { setState, subscribe, subscribeKey }] = store({
 *   count: 0,
 *   name: "Alice"
 * });
 *
 * // Subscribe to all changes
 * const unsub = subscribe((state) => console.log("Changed:", state));
 *
 * // Subscribe to specific key
 * const unsub2 = subscribeKey("count", (val, prev) => {
 *   console.log(`count: ${prev} → ${val}`);
 * });
 * ```
 */
export function store<T extends object>(
  initialState: T,
): [store: { readonly [K in keyof T]: T[K] }, actions: StoreActions<T>] {
  devAssert(
    initialState !== null && typeof initialState === "object" && !Array.isArray(initialState),
    "store: argument must be a plain object. For arrays, use array() instead.",
  );

  // Create individual signals for each key
  const signals: {
    [K in keyof T]: [() => T[K], (value: T[K]) => void];
  } = {} as { [K in keyof T]: [() => T[K], (value: T[K]) => void] };

  // Initialize signals
  (Object.keys(initialState) as Array<keyof T>).forEach((key) => {
    const [getter, setter] = signal(initialState[key]);
    signals[key] = [getter, setter];
  });

  // Proxy to expose reactive getters
  const store = new Proxy({} as T, {
    get(_, prop: string) {
      if (prop in signals) {
        const getter = signals[prop as keyof T][0];
        return getter();
      }
      return undefined;
    },
    set() {
      throw new Error(
        "[SibuJS store] Direct mutation is not allowed. Use actions.setState() to update store properties.",
      );
    },
  });

  // Get non-reactive snapshot of current state
  const getSnapshot = (): T => {
    const snapshot: Partial<T> = {};
    (Object.keys(signals) as Array<keyof T>).forEach((key) => {
      snapshot[key] = signals[key][0]();
    });
    return snapshot as T;
  };

  // Actions
  const setState = (patch: Partial<T> | ((state: T) => T)) => {
    const current = getSnapshot();
    const nextState = typeof patch === "function" ? patch(current) : patch;
    batch(() => {
      Object.entries(nextState).forEach(([key, value]) => {
        if (key in signals) {
          signals[key as keyof T][1](value as T[keyof T]);
        }
      });
    });
  };

  const reset = () => {
    batch(() => {
      (Object.keys(initialState) as Array<keyof T>).forEach((key) => {
        const setter = signals[key][1];
        setter(initialState[key]);
      });
    });
  };

  // Subscribe to all state changes (skips initial invocation)
  const subscribe = (callback: StoreSubscriber<T>): (() => void) => {
    let first = true;
    return effect(() => {
      // Read all signals to register dependencies
      const snapshot = getSnapshot();
      if (first) {
        first = false;
        return;
      }
      callback(snapshot);
    });
  };

  // Subscribe to a specific key (reads initial value inside tracked scope)
  const subscribeKey = <K extends keyof T>(key: K, callback: (value: T[K], prev: T[K]) => void): (() => void) => {
    let prev: T[K] | undefined;
    let first = true;
    return effect(() => {
      const current = signals[key][0]();
      if (first) {
        prev = current;
        first = false;
        return;
      }
      if (!Object.is(current, prev)) {
        const oldPrev = prev as T[K];
        prev = current;
        callback(current, oldPrev);
      }
    });
  };

  return [store, { setState, reset, subscribe, subscribeKey, getSnapshot }];
}
