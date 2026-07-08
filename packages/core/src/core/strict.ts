import { isDev } from "./dev";
import { effect } from "./signals/effect";

// ============================================================================
// STRICT MODE
// ============================================================================
//
// Dev-only helper that double-invokes a callback (or an `effect`) so
// hidden side-effect bugs surface immediately instead of waiting until
// the code happens to run twice in production. Typical offenders:
// double-attaching event listeners, appending DOM nodes without a
// disposer, and mutating module-level state during what looks like a
// one-shot setup.
//
// `strict(fn)` runs the callback once, then re-runs it on a microtask.
// In production it is a no-op (the helper is tree-shaken out). The
// second run happens after the first has finished so cleanups set up by
// the first run are visible.
//
// Per-scope opt-in by design: there is no global wrapper — callers pick
// which setup function gets the double-run treatment.

/**
 * Dev-only wrapper that runs `fn` twice — once now, once on the next
 * microtask. Any hidden side effect (duplicate event listener, missing
 * cleanup, stale closure) shows up immediately.
 *
 * In production builds the helper inlines to a single call.
 *
 * @example
 * ```ts
 * strict(() => {
 *   // Any effect here is invoked twice in dev. If the second run
 *   // causes duplicated listeners or DOM nodes, you have a cleanup bug.
 *   effect(() => {
 *     document.addEventListener("keydown", onKey);
 *     // Forgot to return a disposer — strict() makes this obvious.
 *   });
 * });
 * ```
 */
export function strict<T>(fn: () => T): T {
  const result = fn();
  if (isDev()) {
    queueMicrotask(() => {
      try {
        fn();
      } catch (err) {
        console.warn("[SibuJS strict] second run threw:", err);
      }
    });
  }
  return result;
}

/**
 * Dev-only wrapper that re-runs an effect twice the first time to catch
 * accidental side-effect bleeding. The returned teardown disposes both
 * invocations.
 *
 * This is a thin wrapper around `effect()` — use it instead of `effect()`
 * in any place where you suspect a cleanup bug.
 *
 * @example
 * ```ts
 * const dispose = strictEffect(() => {
 *   const handler = () => { ... };
 *   window.addEventListener("resize", handler);
 *   // Missing `return () => removeEventListener(...)` — strictEffect
 *   // will double-attach in dev and you'll see two log lines.
 * });
 * ```
 */
export function strictEffect(fn: () => void): () => void {
  if (!isDev()) {
    return effect(fn);
  }

  const firstTeardown = effect(fn);
  let secondTeardown: (() => void) | null = null;

  queueMicrotask(() => {
    try {
      secondTeardown = effect(fn);
    } catch (err) {
      console.warn("[SibuJS strictEffect] second run threw:", err);
    }
  });

  return () => {
    firstTeardown();
    if (secondTeardown) secondTeardown();
  };
}
