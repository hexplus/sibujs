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
  /**
   * Per-request data caches (e.g. the query cache). Lazily created and keyed
   * by subsystem so request-scoped data never bleeds between concurrent
   * server renders. Typed loosely to avoid a dependency cycle with data/.
   */
  caches?: Map<string, Map<string, unknown>>;
}

type ALSLike<T> = {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
};

let als: ALSLike<SSRStore> | null = null;
// One-time runtime detection of AsyncLocalStorage. Exactly one branch runs per
// environment (Node-with-getBuiltinModule, Node-CommonJS, or non-Node), so the
// other branches are unreachable in any single coverage run — excluded here.
/* v8 ignore start */
try {
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    type AHMod = { AsyncLocalStorage: new () => ALSLike<SSRStore> };
    let mod: AHMod | null = null;
    // Prefer process.getBuiltinModule (Node 22.3+): synchronous AND works under
    // ESM. The `require`-based path below only works in CommonJS, so under ESM
    // bundles (the common SSR setup) ALS would silently never load and the
    // per-request SSR scope (flag + query cache) would fall back to a shared
    // module global — i.e. cross-request data bleed. getBuiltinModule fixes that.
    const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    if (typeof getBuiltin === "function") {
      mod = getBuiltin("node:async_hooks") as AHMod;
    } else {
      const req = (Function("return typeof require==='function'?require:null") as () => NodeRequire | null)();
      if (req) mod = req("node:async_hooks") as AHMod;
    }
    if (mod) als = new mod.AsyncLocalStorage();
  }
} catch {
  als = null;
}
/* v8 ignore stop */

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

/**
 * Returns a request-scoped cache map for the given subsystem when running
 * under SSR (so concurrent requests never share it), or `null` on the client
 * where a process-global cache is correct. On Node the store is backed by
 * AsyncLocalStorage, giving each request its own caches.
 */
export function getRequestScopedCache<V>(name: string): Map<string, V> | null {
  if (!isSSR()) return null;
  const store = getSSRStore();
  const caches = (store.caches ??= new Map<string, Map<string, unknown>>());
  let c = caches.get(name);
  if (!c) {
    c = new Map<string, unknown>();
    caches.set(name, c);
  }
  return c as Map<string, V>;
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
  // Module-global fallback for runtimes without AsyncLocalStorage (browser,
  // some edge runtimes). Unreachable under the Node test runner where `als`
  // is always present.
  /* v8 ignore next 11 */
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
