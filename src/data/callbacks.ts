/**
 * Isolation helpers for user-supplied data-layer callbacks.
 *
 * The contract these enforce (DATA-001 / DATA-002):
 *
 *   A callback exception is not an operation failure.
 *
 * Every data primitive runs its request inside a `try`/`catch` that decides the
 * operation's success or failure. User callbacks — `select`, `onSuccess`,
 * `onError`, `onSettled`, `onStart`, and cache listeners — used to run inside
 * that same `try`, which meant a throwing callback was indistinguishable from a
 * failed request:
 *
 *   fetch succeeds → cache commits → onSuccess throws → caught by the request's
 *   own catch → the entry is stamped with the *callback's* error, `onError` is
 *   invoked with it, and every observer of that shared key is told the request
 *   failed.
 *
 * Listener iteration had the matching flaw: an unguarded
 * `for (const l of listeners) l()` aborts at the first throw, so one observer's
 * broken `select` starved every observer registered after it.
 *
 * These helpers are internal — deliberately not re-exported from `data.ts`.
 * They introduce no new public error API; reporting goes through `console.error`
 * following the same "catch, report, keep going" convention as
 * `safeCall()` in `core/rendering/lifecycle.ts`. `console.error` rather than
 * `devWarn` because these are silent data-integrity events: swallowing them in
 * production is exactly the failure mode being fixed.
 */

/**
 * Report a user callback's exception on its own channel, decoupled from the
 * operation's error state.
 */
export function reportCallbackError(label: string, error: unknown): void {
  if (typeof console !== "undefined") {
    console.error(`[SibuJS data] ${label} threw. The operation's own status is unaffected.`, error);
  }
}

/**
 * Invoke a user callback so that its exception can never reach the caller's
 * `try`/`catch` and be mistaken for a request failure.
 */
export function runCallback(label: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    reportCallbackError(label, error);
  }
}

/**
 * Apply a user `select` transform.
 *
 * Returns a result object rather than a bare value so the caller can tell
 * "transformed to `undefined`" from "the transform failed" — on failure the
 * caller keeps whatever data it already had instead of committing a wrong one.
 */
export function runSelect<T>(label: string, fn: () => T): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    reportCallbackError(label, error);
    return { ok: false };
  }
}

/**
 * Notify every listener of a shared cache entry, isolating each from the
 * others' exceptions.
 *
 * Iterates a snapshot: a listener may attach or detach an observer while it
 * runs, and mutating the live `Set` mid-iteration would otherwise decide who
 * gets notified by accident.
 */
export function notifyListeners(listeners: Iterable<() => void>, label: string): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (error) {
      reportCallbackError(label, error);
    }
  }
}
