/**
 * Bundle size optimization utilities for SibuJS.
 * Provides markers and utilities for tree-shaking and dead code elimination.
 */

/**
 * Invoke a factory and return its result. The PURE annotation that enables
 * tree-shaking is only honoured at the call site, not inside the function
 * declaration. Annotate call sites like this:
 *
 *     const x = /\* @__PURE__ *\/ pure(() => expensive());
 */
export function pure<T>(fn: () => T): T {
  return fn();
}

/**
 * Conditional import helper for tree-shaking.
 * Only includes the module in the bundle if the condition is true.
 * In production builds, dead branches are eliminated.
 */
export function conditional<T>(condition: boolean, loader: () => T): T | undefined {
  if (condition) return loader();
  return undefined;
}

/**
 * Feature flag helper for dead code elimination.
 * Bundlers can statically replace these with true/false to eliminate dead code.
 */
export const Features = {
  SSR: typeof window === "undefined",
  DEV: typeof process !== "undefined" && process.env?.NODE_ENV !== "production",
  BROWSER: typeof window !== "undefined",
} as const;

/**
 * Development-only code block. Eliminated in production builds
 * when process.env.NODE_ENV is set to 'production'.
 */
export function devOnly(fn: () => void): void {
  if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
    fn();
  }
}

/**
 * Marks an export as having no side effects.
 * Used by module-level sideEffects annotation.
 */
export function noSideEffect<T extends (...args: unknown[]) => unknown>(fn: T): T {
  return fn;
}
