/**
 * Development-mode utilities for SibuJS.
 *
 * All functions in this module are designed to be tree-shaken in production
 * builds via the __SIBU_DEV__ global constant (set by the Vite plugin).
 *
 * In production: dead code elimination removes all dev checks entirely.
 * In development: provides clear, actionable error messages.
 */

declare const __SIBU_DEV__: boolean | undefined;

/**
 * Returns true when running in development mode.
 * Tree-shakes to `false` in production builds.
 */
export function isDev(): boolean {
  return typeof (globalThis as any).__SIBU_DEV__ !== "undefined"
    ? !!(globalThis as any).__SIBU_DEV__
    : typeof __SIBU_DEV__ !== "undefined"
      ? __SIBU_DEV__
      : typeof process !== "undefined" && process.env?.NODE_ENV !== "production"; // safe default: off in browser, on in test/dev Node
}

// Cache dev mode at module load — avoids 3 typeof checks per call
const _isDev = isDev();

/**
 * Assert a condition in dev mode only. No-op in production.
 */
export function devAssert(condition: boolean, message: string): void {
  if (_isDev && !condition) {
    throw new Error(`[SibuJS] ${message}`);
  }
}

/**
 * Warn in dev mode only. No-op in production.
 */
export function devWarn(message: string): void {
  if (_isDev) {
    console.warn(`[SibuJS] ${message}`);
  }
}
