/**
 * Development-mode utilities for SibuJS.
 *
 * All functions in this module are designed to be tree-shaken in production
 * builds via the __SIBU_DEV__ global constant (set by the Vite plugin).
 *
 * In production: dead code elimination removes all dev checks entirely.
 * In development: provides clear, actionable error messages.
 *
 * `tests/treeshaking-dev-diagnostics.test.ts` bundles this for real and asserts
 * the message strings are gone, so a regression here fails the suite rather
 * than quietly shipping every warning to every consumer.
 */

declare const __SIBU_DEV__: boolean | undefined;

/**
 * Dev mode as a **statically foldable constant**, snapshotted at module load.
 *
 * Prefer this over {@link isDev} for any guard whose only job is to gate a
 * diagnostic. The distinction is not stylistic — it decides whether the
 * diagnostic exists in a consumer's production bundle:
 *
 * - `DEV` inlines its `__SIBU_DEV__` define into every reference, so
 *   `if (DEV) …` becomes `if (false) …` and the whole branch — warning strings
 *   included — is deleted.
 * - `isDev()` is a function CALL. Bundlers do not inline calls across modules,
 *   so `const _isDev = isDev()` produces a runtime `var` and every branch that
 *   reads it survives minification with its message strings intact. That alias
 *   is exactly why this library used to ship every warning it could emit.
 *
 * Use {@link isDev} only where the answer must be read LIVE at call time rather
 * than snapshotted at import time (devtools opt-in defaults, `strict()`).
 *
 * THREE THINGS ABOUT THIS DECLARATION ARE LOAD-BEARING. Changing any of them
 * silently un-strips every diagnostic in the library:
 *
 * 1. **It must be the first declaration in this module.** esbuild inlines a
 *    cross-module `const` only when no hoisted declaration precedes it;
 *    anything above it (a function, another const) makes the inliner give up
 *    and emit a runtime `var` instead. Verified empirically — moving `isDev`
 *    above this line is enough to put every warning string back in the bundle.
 * 2. **It must be an inline expression, not `isDev()`.** A cross-module call is
 *    opaque to the bundler, which is the problem this constant exists to solve.
 * 3. **The bare `__SIBU_DEV__` must come first in the ladder.** Only a bare
 *    identifier is a `define` target; `globalThis.__SIBU_DEV__` is a member
 *    expression and can never be substituted or folded.
 *
 * With no define at all (raw ESM, the test runner) an unqualified
 * `__SIBU_DEV__` resolves to the global of that name, so the first branch reads
 * the same value the `globalThis` branch would — which is why it coerces with
 * `!!`: a test may set the override to `1` or `0` and still expect a strict
 * boolean back. The runtime escape hatch `tests/prod-mode.test.ts` relies on
 * keeps working, and diagnostics correctly stay in an unconfigured build.
 */
export const DEV: boolean =
  typeof __SIBU_DEV__ !== "undefined"
    ? !!__SIBU_DEV__
    : typeof (globalThis as any).__SIBU_DEV__ !== "undefined"
      ? !!(globalThis as any).__SIBU_DEV__
      : // safe default: off in browser, on in test/dev Node
        typeof process !== "undefined" && process.env?.NODE_ENV !== "production";

/**
 * Returns true when running in development mode, read LIVE at call time.
 *
 * Unlike {@link DEV} this is a real call, so it observes a `__SIBU_DEV__`
 * global that changed after module load. That also means it cannot be folded
 * away: use it for behavior (devtools defaults, `strict()`), never as the guard
 * on a warning string, or the string ships to production.
 *
 * @returns `true` in development, `false` in production.
 */
export function isDev(): boolean {
  // globalThis FIRST — the opposite of {@link DEV}, deliberately.
  //
  // This function exists to be read live, and only the runtime global can
  // change after load. Consulting the bare `__SIBU_DEV__` first would let a
  // build-time define answer for it in any bundled build, making the runtime
  // override dead code there and turning this into a slower copy of `DEV` —
  // while the doc above promised a live read. Nothing here needs to fold, so
  // ordering costs nothing.
  if (typeof (globalThis as any).__SIBU_DEV__ !== "undefined") return !!(globalThis as any).__SIBU_DEV__;
  if (typeof __SIBU_DEV__ !== "undefined") return !!__SIBU_DEV__;
  return typeof process !== "undefined" && process.env?.NODE_ENV !== "production";
}

/**
 * Assert a condition in dev mode only. No-op in production.
 *
 * @param condition Asserted expression; a falsy value throws in dev.
 * @param message Message for the thrown error, prefixed with `[SibuJS]`.
 * @returns Nothing. Throws in dev when `condition` is falsy; in production the
 * entire body — message string included — is eliminated at build time.
 */
export function devAssert(condition: boolean, message: string): void {
  // See `devWarn` for why the define test is repeated inline instead of reusing
  // `DEV`. Same reason, same requirement: this body must be able to fold to
  // nothing so the message strings never reach a production bundle.
  if ((typeof __SIBU_DEV__ !== "undefined" ? __SIBU_DEV__ : DEV) && !condition) {
    throw new Error(`[SibuJS] ${message}`);
  }
}

/**
 * Warn in dev mode only. No-op in production.
 *
 * Because the body is guarded by {@link DEV}, a production bundler folds this
 * function to an empty one, inlines it at every call site, and drops the
 * message literals with it — so a `devWarn` call costs nothing in production
 * even when the call site itself is unguarded.
 *
 * @param message Warning text, printed to `console.warn` prefixed `[SibuJS]`.
 * @returns Nothing.
 */
/**
 * Warn in dev only, composing the message lazily.
 *
 * @param build Called only in development; returns the warning text. Returning
 * an empty string suppresses the warning, which lets a builder do its own
 * de-duplication without that bookkeeping escaping into production.
 * @returns Nothing. In production the call, the callback, and every string and
 * lookup table the callback references are eliminated at build time.
 */
export function devWarnLazy(build: () => string): void {
  // Same inline define test as `devWarn`, for the same reason — but this form
  // also strips the WORK of composing the message, not just the call.
  //
  // `if (DEV) { const why = …long text…; devWarn(why); }` does NOT strip in a
  // published build: `DEV` arrives as a runtime var there, so the branch is not
  // provably dead and its string literals ship. Moving the composition into a
  // callback fixes it, because this body folds to nothing, the bundler inlines
  // it, and the now-unreferenced closure — with every literal and lookup table
  // it touched — is tree-shaken away.
  //
  // Use this for any diagnostic that branches on the situation, interpolates,
  // or reads a table of explanatory text. Use `devWarn` for a plain literal.
  if (typeof __SIBU_DEV__ !== "undefined" ? __SIBU_DEV__ : DEV) {
    const message = build();
    if (message) console.warn(`[SibuJS] ${message}`);
  }
}

export function devWarn(message: string): void {
  // The `__SIBU_DEV__` test is repeated INLINE here rather than reusing `DEV`,
  // and that redundancy is the point.
  //
  // `DEV` folds only when it is the first declaration in the emitted module.
  // That holds when a consumer bundles this package's SOURCE, but the published
  // `dist` chunk carries the bundler's own runtime helpers (`__defProp`,
  // `__export`) above it, which is enough to make the downstream inliner give
  // up: `DEV` arrives as a runtime `var`, this body never becomes empty, and
  // every message string in the library ships to production even though none
  // can ever print.
  //
  // Testing the define directly sidesteps that entirely. With
  // `__SIBU_DEV__: false` the condition folds to `false` here regardless of how
  // `DEV` was emitted, the body becomes empty, and the bundler then inlines
  // this function at each call site and drops the message argument with it —
  // so an unguarded `devWarn(…)` costs a production consumer nothing.
  //
  // With no define, an unqualified `__SIBU_DEV__` resolves to the global of
  // that name, so the behaviour is identical to reading `DEV`.
  if (typeof __SIBU_DEV__ !== "undefined" ? __SIBU_DEV__ : DEV) {
    console.warn(`[SibuJS] ${message}`);
  }
}
