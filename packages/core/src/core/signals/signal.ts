import { enqueueBatchedSignal } from "../../reactivity/batch";
import type { ReactiveSignal } from "../../reactivity/signal";
import { notifySubscribers, recordDependency } from "../../reactivity/track";
import { isDev } from "../dev";

// Phantom brand symbol — exists only in the type system, never at runtime.
declare const __accessor: unique symbol;

/**
 * A reactive signal getter returned by signal(), derived(), and similar primitives.
 *
 * Pass an Accessor directly into reactive prop positions — never call it there:
 * ```ts
 * const [count, setCount] = signal(0);
 *
 * div(count)                       // ✓ reactive — Accessor passed directly
 * div(() => count())               // ✓ reactive — explicit arrow wrapper
 * div(count())                     // ✗ static  — evaluated once, not reactive
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
  // Pre-initialize every internal field the reactivity core touches. This
  // keeps the V8 hidden class stable across all signals — inline caches in
  // recordDependency / notifySubscribers / link helpers stay monomorphic
  // instead of transitioning on first subscribe, first notify, etc.
  //
  //   value          — user's current value
  //   __v            — version counter, bumped only on actual change
  //   __sc           — subscriber count (O(1) devtools reads)
  //   subsHead/Tail  — doubly-linked subscriber list
  //   __activeNode   — back-pointer for O(1) dup dep detection during tracking
  //   __name         — optional debug label
  const state: {
    value: T;
    __v: number;
    __sc: number;
    subsHead: unknown;
    subsTail: unknown;
    __activeNode: unknown;
    __name?: string;
  } = {
    value: initial,
    __v: 0,
    __sc: 0,
    subsHead: null,
    subsTail: null,
    __activeNode: null,
    __name: undefined,
  };
  const debugName = _isDev ? options?.name : undefined;
  const equalsFn = options?.equals;

  // Debug name is pre-declared on the state shape so the hidden class stays
  // stable whether or not a name is provided.
  if (debugName) state.__name = debugName;

  function get(): T {
    recordDependency(state as ReactiveSignal);
    return state.value;
  }

  // Tag getter with signal reference for dependency introspection
  (get as unknown as Record<string, unknown>).__signal = state;
  if (debugName) (get as unknown as Record<string, unknown>).__name = debugName;

  // --- Setter: two specialized variants (Object.is fast path vs custom equals)
  //
  // V8 optimizes monomorphic function shapes better than polymorphic ones.
  // Signals with the default equals (Object.is) are by far the common case;
  // giving them their own closure with no branch on `equalsFn` lets the JIT
  // inline it. Signals with custom equals pay the extra call, same as before.
  //
  // Dev-mode devtools hook emission lives behind the cached `_isDev` so
  // production closures don't carry the branch either.
  // ---------------------------------------------------------------------------
  let set: SetState<T>;

  if (equalsFn) {
    set = (next) => {
      const prev = state.value;
      const newValue = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      if (equalsFn(prev, newValue)) return;
      state.value = newValue;
      state.__v++;
      if (_isDev) {
        const hook = _g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
        if (hook) hook.emit("signal:update", { signal: state, name: debugName, oldValue: prev, newValue });
      }
      if (!enqueueBatchedSignal(state as ReactiveSignal)) {
        notifySubscribers(state as ReactiveSignal);
      }
    };
  } else if (_isDev) {
    set = (next) => {
      const prev = state.value;
      const newValue = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      if (Object.is(newValue, prev)) return;
      state.value = newValue;
      state.__v++;
      const hook = _g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
      if (hook) hook.emit("signal:update", { signal: state, name: debugName, oldValue: prev, newValue });
      if (!enqueueBatchedSignal(state as ReactiveSignal)) {
        notifySubscribers(state as ReactiveSignal);
      }
    };
  } else {
    // Production hot path — smallest possible setter. No dev hook, no custom
    // equals branch, no debug-name lookup.
    set = (next) => {
      const prev = state.value;
      const newValue = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      if (Object.is(newValue, prev)) return;
      state.value = newValue;
      state.__v++;
      if (!enqueueBatchedSignal(state as ReactiveSignal)) {
        notifySubscribers(state as ReactiveSignal);
      }
    };
  }

  if (_isDev) {
    const hook = _g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
    if (hook) hook.emit("signal:create", { signal: state, name: debugName, getter: get, initial });
  }

  return [get as Accessor<T>, set];
}
