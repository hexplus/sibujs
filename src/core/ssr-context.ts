/**
 * SSR context for SibuJS.
 *
 * During server-side rendering, side effects (effect, watch, onMount)
 * should not run. This module provides a flag to enable/disable SSR mode.
 *
 * Concurrency: on Node we back the flag with AsyncLocalStorage so
 * simultaneous requests get independent SSR scopes. On runtimes without
 * AsyncLocalStorage (browser, some edge runtimes) we fall back to a
 * module-global boolean.
 *
 * Usage:
 *   enableSSR();        // Call before rendering on the server
 *   renderToString(...);
 *   disableSSR();       // Call after rendering (cleanup)
 *
 * Or use the scoped helper:
 *   withSSR(() => renderToString(...));
 *   runInSSRContext(() => renderToString(...));
 */

/**
 * Per-request SSR store. Currently holds the SSR flag plus a
 * suspense-id counter so concurrent streaming renders never collide.
 */
export interface SSRStore {
  ssr: boolean;
  suspenseIdCounter: number;
}

type ALSLike<T> = {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
};

let als: ALSLike<SSRStore> | null = null;
try {
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    // Synchronous require to avoid async import rippling through the API.
    // Wrapped so bundlers targeting the browser silently skip it.
    const req = (Function("return typeof require==='function'?require:null") as () => NodeRequire | null)();
    if (req) {
      const mod = req("node:async_hooks") as { AsyncLocalStorage: new () => ALSLike<SSRStore> };
      als = new mod.AsyncLocalStorage();
    }
  }
} catch {
  als = null;
}

// Fallback store used when AsyncLocalStorage is unavailable.
const fallbackStore: SSRStore = { ssr: false, suspenseIdCounter: 0 };

/** Returns the active store (ALS or fallback). */
export function getSSRStore(): SSRStore {
  if (als) {
    const s = als.getStore();
    if (s) return s;
  }
  return fallbackStore;
}

/** Returns true when running in SSR mode. */
export function isSSR(): boolean {
  return getSSRStore().ssr;
}

/** Enable SSR mode. Side effects (effect, watch, onMount) become no-ops. */
export function enableSSR(): void {
  getSSRStore().ssr = true;
}

/** Disable SSR mode. Side effects resume normal behavior. */
export function disableSSR(): void {
  getSSRStore().ssr = false;
}

/**
 * Run `fn` inside a fresh request-scoped SSR context. On Node this uses
 * AsyncLocalStorage so concurrent requests never share state; elsewhere
 * it falls back to mutating the module-global store.
 */
export function runInSSRContext<T>(fn: () => T): T {
  const store: SSRStore = { ssr: true, suspenseIdCounter: 0 };
  if (als) {
    return als.run(store, fn);
  }
  const prevSSR = fallbackStore.ssr;
  const prevCounter = fallbackStore.suspenseIdCounter;
  fallbackStore.ssr = true;
  fallbackStore.suspenseIdCounter = 0;
  try {
    return fn();
  } finally {
    fallbackStore.ssr = prevSSR;
    fallbackStore.suspenseIdCounter = prevCounter;
  }
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
  const store = getSSRStore();
  const wasSSR = store.ssr;
  store.ssr = true;
  try {
    return fn();
  } finally {
    if (!wasSSR) store.ssr = false;
  }
}
