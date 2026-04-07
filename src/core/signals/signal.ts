import { enqueueBatchedSignal } from "../../reactivity/batch";
import type { ReactiveSignal } from "../../reactivity/signal";
import { notifySubscribers, recordDependency } from "../../reactivity/track";
import { isDev } from "../dev";

// Phantom brand symbol — exists only in the type system, never at runtime.
declare const __accessor: unique symbol;

/**
 * A reactive signal getter returned by signal(), derived(), memo(), and similar primitives.
 *
 * Pass an Accessor directly into reactive prop positions — never call it there:
 * ```ts
 * const [count, setCount] = signal(0);
 *
 * div({ nodes: count })           // ✓ reactive — Accessor passed directly
 * div({ nodes: () => count() })   // ✓ reactive — explicit arrow wrapper
 * div({ nodes: count() })         // ✗ static  — evaluated once, not reactive
 * ```
 */
export type Accessor<T> = (() => T) & { readonly [__accessor]?: never };

type SetState<T> = (next: T | ((prev: T) => T)) => void;
type StateTuple<T> = [Accessor<T>, SetState<T>];

/** Options for signal */
export interface SignalOptions<T = unknown> {
  /** Debug name for devtools inspection. Only used in development. */
  name?: string;
  /** Custom equality function. Defaults to Object.is(). */
  equals?: (prev: T, next: T) => boolean;
}

// DevTools hook accessor — property read is cheap (single hash lookup),
// and allows tests to set the hook after module load.
const _g = globalThis as any;

// Cache dev mode at module load — avoids checking on every signal write
const _isDev = isDev();

/**
 * signal creates a reactive signal that holds a value of type T.
 * Returns a tuple: [getter, setter].
 *
 * @param initial Initial value
 * @param options Optional config: `{ name: "count" }` for devtools labeling
 */
export function signal<T>(initial: T, options?: SignalOptions<T>): StateTuple<T> {
  const state: { value: T } = { value: initial };
  const debugName = _isDev ? options?.name : undefined;
  const equalsFn = options?.equals;

  // Tag signal with debug name for devtools/introspection
  if (debugName) {
    (state as Record<string, unknown>).__name = debugName;
  }

  function get(): T {
    recordDependency(state as ReactiveSignal);
    return state.value;
  }

  // Tag getter with signal reference for dependency introspection
  (get as unknown as Record<string, unknown>).__signal = state;
  if (debugName) (get as unknown as Record<string, unknown>).__name = debugName;

  function set(next: T | ((prev: T) => T)): void {
    const newValue = typeof next === "function" ? (next as (prev: T) => T)(state.value) : next;
    if (equalsFn ? equalsFn(state.value, newValue) : Object.is(newValue, state.value)) return;

    if (_isDev) {
      const oldValue = state.value;
      state.value = newValue;
      const hook = _g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
      if (hook) hook.emit("signal:update", { signal: state, name: debugName, oldValue, newValue });
    } else {
      state.value = newValue;
    }

    if (!enqueueBatchedSignal(state as ReactiveSignal)) {
      notifySubscribers(state as ReactiveSignal);
    }
  }

  if (_isDev) {
    const hook = _g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
    if (hook) hook.emit("signal:create", { signal: state, name: debugName, getter: get, initial });
  }

  return [get as Accessor<T>, set];
}
