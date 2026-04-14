import { track, untracked } from "../../reactivity/track";
import { devAssert } from "../dev";
import { isSSR } from "../ssr-context";

/** Options for effect */
export interface EffectOptions {
  /** Error handler for exceptions thrown during effect execution. */
  onError?: (error: unknown) => void;
}

const _g = globalThis as any;

/**
 * Creates a callback that only tracks the specified dependencies,
 * running the handler in an untracked context. Use with `effect()`
 * to control exactly which signals trigger re-execution.
 *
 * @param deps Getter(s) whose return values are tracked as dependencies
 * @param handler Called with the current dependency value(s) whenever they change
 * @returns A function suitable for passing to `effect()`
 *
 * @example
 * ```ts
 * const [count, setCount] = signal(0);
 * const [label, setLabel] = signal("clicks");
 *
 * // Only re-runs when count changes, NOT when label changes
 * effect(on(() => count(), (c) => {
 *   console.log(`${c} ${label()}`);  // label() read but not tracked
 * }));
 * ```
 */
export function on<T>(deps: () => T, handler: (value: T, prev: T | undefined) => void): () => void {
  let prev: T | undefined;
  let first = true;

  return () => {
    const value = deps();
    if (first) {
      first = false;
      prev = value;
      untracked(() => handler(value, undefined));
    } else {
      const p = prev;
      prev = value;
      untracked(() => handler(value, p));
    }
  };
}

/** Registers a function to run before the effect re-runs or is disposed.
 *  Called with the same signature inside every invocation. */
export type OnCleanup = (fn: () => void) => void;

/** The user's effect body — may accept an `onCleanup` callback to register
 *  teardown that runs before the next re-run or on dispose. */
export type EffectBody = (onCleanup: OnCleanup) => void;

/**
 * effect runs the provided effectFn immediately and re-runs it whenever
 * any reactive dependency changes.
 * Returns a cleanup function to stop further executions.
 *
 * In SSR mode, effect is a no-op — side effects should not run on the server.
 *
 * @example addEventListener pattern with built-in teardown:
 * ```ts
 * effect((onCleanup) => {
 *   const handler = (e: Event) => { ... };
 *   window.addEventListener("resize", handler);
 *   onCleanup(() => window.removeEventListener("resize", handler));
 * });
 * ```
 */
export function effect(effectFn: EffectBody | (() => void), options?: EffectOptions): () => void {
  devAssert(typeof effectFn === "function", "effect: argument must be a function.");

  // No-op during SSR — side effects are client-only
  if (isSSR()) return () => {};

  const onError = options?.onError;
  // Per-run cleanup callbacks registered via the onCleanup arg. Cleared and
  // drained before each re-run and on dispose, in reverse registration order.
  let userCleanups: Array<() => void> = [];
  const onCleanup: OnCleanup = (fn) => {
    userCleanups.push(fn);
  };
  const runUserCleanups = () => {
    if (userCleanups.length === 0) return;
    const list = userCleanups;
    userCleanups = [];
    for (let i = list.length - 1; i >= 0; i--) {
      try {
        list[i]();
      } catch (err) {
        if (typeof console !== "undefined") {
          console.warn("[SibuJS effect] onCleanup threw:", err);
        }
      }
    }
  };

  const invokeBody = () => (effectFn as EffectBody)(onCleanup);

  // When onError is provided, wrap the effect function in a try/catch.
  // When not provided, use the raw effectFn — zero overhead for the default case.
  const wrappedFn = onError
    ? () => {
        try {
          invokeBody();
        } catch (err) {
          onError(err);
        }
      }
    : invokeBody;

  let cleanupHandle: () => void = () => {};
  let running = false;

  const subscriber = () => {
    if (running) {
      // Effect wrote to a signal it depends on while still running. We
      // can't re-enter without risking infinite recursion, so the update
      // is dropped — surface it in dev so the developer can debug.
      if (_g.__SIBU_DEV_WARN__ !== false && typeof console !== "undefined") {
        console.warn(
          "[SibuJS] effect re-entered itself while running — " +
            "the triggering update will be ignored. Wrap mutual writes in `batch()` " +
            "or split the effect to avoid this.",
        );
      }
      return;
    }
    running = true;
    try {
      // Run user onCleanup BEFORE cleanupHandle so user teardown observes
      // the reactive state from the previous run (e.g. before subs are cut).
      runUserCleanups();
      cleanupHandle();
      cleanupHandle = track(wrappedFn, subscriber);
    } finally {
      running = false;
    }
  };

  running = true;
  try {
    cleanupHandle = track(wrappedFn, subscriber);
  } finally {
    running = false;
  }

  const hook = _g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  if (hook) hook.emit("effect:create", { effectFn });

  let disposed = false;
  return () => {
    // Idempotent — user code composing disposers (Array.push(dispose)) may
    // inadvertently call twice. Second call should be a no-op, not re-emit
    // effect:destroy or re-run cleanupHandle (which re-walks subs lists).
    if (disposed) return;
    disposed = true;
    const h = _g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
    if (h) {
      try {
        h.emit("effect:destroy", { effectFn });
      } catch {
        /* devtools hook errors should not break user teardown */
      }
    }
    try {
      runUserCleanups();
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn("[SibuJS effect] onCleanup threw during dispose:", err);
      }
    }
    try {
      cleanupHandle();
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn("[SibuJS effect] dispose threw:", err);
      }
    }
  };
}
