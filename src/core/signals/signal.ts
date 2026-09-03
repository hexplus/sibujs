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
  //   _d / _validate — declared but never set on a plain signal. The reactive
  //                    core tests both when deciding whether a dependency needs
  //                    settling before its version can be trusted; declaring
  //                    them here means those reads hit a real slot on this
  //                    shape instead of missing through the prototype chain on
  //                    the hottest paths (recordDependency, depsChanged).
  const state: {
    value: T;
    __v: number;
    __sc: number;
    subsHead: unknown;
    subsTail: unknown;
    __activeNode: unknown;
    __name?: string;
    _d: boolean;
    _validate: undefined;
  } = {
    value: initial,
    __v: 0,
    __sc: 0,
    subsHead: null,
    subsTail: null,
    __activeNode: null,
    __name: undefined,
    _d: false,
    _validate: undefined,
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

// ---------------------------------------------------------------------------
// external() — reactive integration with state SibuJS does not own.
//
// SibuJS tracks reads of ITS OWN signals. A `Chess` instance, a `<canvas>`
// scene graph, a CodeMirror document, a WebSocket-owned cache — all keep their
// state in objects the runtime never sees written. Nothing can be tracked, so
// nothing can be invalidated.
//
// The honest primitive for that is a reactive token with NO value: consumers
// declare "I read from this engine" (`track()`), and the code that mutated the
// engine declares "the engine changed" (`invalidate()`). Dependency tracking
// and invalidation are separated, which is precisely the property an external
// engine breaks.
//
// It deliberately does NOT proxy, clone, deep-compare or otherwise observe the
// external object. That is not a limitation to be engineered away later: a
// generic mechanism that could detect arbitrary third-party mutation does not
// exist without owning the data, and pretending otherwise produces silent
// staleness rather than an explicit call site.
//
// WHY IT LIVES IN THIS FILE rather than one of its own: the build splits `dist`
// into shared chunks, and a module reachable only from the root entry lands in
// the large index-only chunk together with `enhance`, `mountIslands`, `mount`
// and `each`. Importing it would then drag the whole island runtime into a page
// that only wanted to make a canvas reactive — 77 KB instead of 12 KB, measured.
// `signal.ts` is in the small chunk every entry point shares, so defining the
// primitive beside the signal it is built from is what keeps it independently
// tree-shakeable. `tests/treeshaking-islands.test.ts` pins that.
// ---------------------------------------------------------------------------

/**
 * A valueless reactive token standing in for state SibuJS does not own.
 *
 * See {@link external}.
 */
export interface ExternalSource {
  /**
   * Declare, from inside a reactive computation, that it reads the external
   * state this source represents. Call it in the same places you would read a
   * signal — the top of a binding getter, a `derived()` body, an `effect()`.
   *
   * Outside a tracking context it is a no-op, exactly like reading a signal.
   */
  track(): void;
  /**
   * Declare that the external state changed. Every consumer that called
   * {@link ExternalSource.track} is invalidated.
   *
   * Participates in `batch()` like any signal write: inside a batch, consumers
   * are notified once when the outermost batch flushes.
   */
  invalidate(): void;
}

/**
 * Create a reactive source for state that lives outside SibuJS — a domain
 * engine, a media element, a canvas scene, an editor document, a cache a
 * socket writes into.
 *
 * The pattern is two lines: `track()` where you read, `invalidate()` after you
 * mutate.
 *
 * ```ts
 * import { Chess } from "chess.js";
 * import { external } from "sibujs";
 *
 * const game = new Chess();      // owns the rules and the mutable state
 * const moved = external();      // owns "something changed"
 *
 * ctx.text("@status", () => {
 *   moved.track();               // this binding reads the engine
 *   return game.isCheckmate() ? "Checkmate" : `${game.turn()} to move`;
 * });
 *
 * game.move({ from: "e2", to: "e4" });
 * moved.invalidate();            // every consumer above re-reads
 * ```
 *
 * **One source is one invalidation domain.** Every consumer of a source
 * re-runs on every `invalidate()`, so the granularity of your updates is
 * exactly the granularity of your sources: one for a whole engine is the
 * cheapest to write, several (`board`, `clock`, `history`) let an update touch
 * only what it affects. See `docs/architecture/external-state.md` for the
 * trade-offs and when subdividing is worth it.
 *
 * Ownership, disposal and error routing are the consumer's, not the source's:
 * a disposed binding or effect is never invalidated, and a consumer that
 * throws is reported through the normal runtime error pipeline with its own
 * phase and node.
 *
 * @param options `name` labels the source in devtools (development only).
 */
export function external(options?: { name?: string }): ExternalSource {
  // Implemented on top of `signal` rather than against the reactive core
  // directly, so batching, the notification drain, version-based
  // stabilization, duplicate-runtime coordination and devtools all behave
  // identically to every other reactive source with no second implementation
  // of those invariants to keep in step.
  //
  // The counter is an implementation detail and is never handed out: `track()`
  // returns void, so no consumer can come to depend on the number, and there
  // is no "revision" for application code to thread through its own state.
  const [version, bump] = signal(0, options?.name ? { name: options.name } : undefined);

  return {
    track(): void {
      version();
    },
    invalidate(): void {
      bump((n) => n + 1);
    },
  };
}
