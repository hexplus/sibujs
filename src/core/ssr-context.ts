/**
 * SSR context for SibuJS.
 *
 * During server-side rendering, side effects (effect, watch, onMount)
 * should not run. This module provides a flag to enable/disable SSR mode.
 *
 * Usage:
 *   enableSSR();        // Call before rendering on the server
 *   renderToString(...);
 *   disableSSR();       // Call after rendering (cleanup)
 *
 * Or use the scoped helper:
 *   withSSR(() => renderToString(...));
 */

let ssrMode = false;

/** Returns true when running in SSR mode. */
export function isSSR(): boolean {
  return ssrMode;
}

/** Enable SSR mode. Side effects (effect, watch, onMount) become no-ops. */
export function enableSSR(): void {
  ssrMode = true;
}

/** Disable SSR mode. Side effects resume normal behavior. */
export function disableSSR(): void {
  ssrMode = false;
}

/**
 * Run a function in SSR mode. Automatically enables/disables SSR around the callback.
 * Returns whatever the callback returns.
 *
 * Nesting-safe: saves the prior SSR flag and restores it in the `finally`
 * block. A nested `withSSR(...)` call cannot prematurely flip the outer
 * scope's SSR flag back to `false`, and an exception thrown inside `fn`
 * still leaves the flag in its original state.
 */
export function withSSR<T>(fn: () => T): T {
  const wasSSR = ssrMode;
  enableSSR();
  try {
    return fn();
  } finally {
    if (!wasSSR) disableSSR();
  }
}
