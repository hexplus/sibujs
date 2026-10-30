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
import { devWarn } from "./dev";
import { hydrationPending } from "./rendering/hydrationHooks";
export interface SSRStore {
  ssr: boolean;
  suspenseIdCounter: number;
  /**
   * `createId()` counter for this request. Request-scoped for the same reason
   * as `suspenseIdCounter`: a server render's ids must not depend on earlier or
   * concurrent requests, and must match a fresh client's sequence. Optional so
   * stores created elsewhere start it lazily at 0.
   */
  idCounter?: number;
  /**
   * Per-request data caches (e.g. the query cache). Lazily created and keyed
   * by subsystem so request-scoped data never bleeds between concurrent
   * server renders. Typed loosely to avoid a dependency cycle with data/.
   */
  caches?: Map<string, Map<string, unknown>>;
  /**
   * The locale this request has selected, or `undefined` when it has not
   * chosen one and should follow the application default.
   *
   * A plain string rather than a signal: reactive locale switching is a client
   * concern (one page, one active locale, subscribers to notify), while a
   * server render reads the value once per request and never re-renders. Giving
   * every request its own signal would allocate subscriber machinery nothing
   * will ever use. See `plugins/i18n.ts`.
   */
  locale?: string;
  /**
   * Async work started inside this request that a server render must wait for
   * before it serializes: `lazy()` chunks, `query()` / `resource()` fetches, the
   * router's initial navigation and route loads, `prerenderWait()` promises.
   * Created by `runInSSRContext`; `settled()` drains it. See `trackPending`.
   */
  pending?: Set<PendingWork>;
  /** Called whenever an entry leaves `pending`, so a waiting `settled()` re-checks. */
  wake?: (() => void) | null;
  /**
   * Errors no `ErrorBoundary` claimed during this request. When present,
   * `reportError` records them here instead of the console, and an async
   * server render rejects with the first one.
   */
  errors?: Array<{ error: Error; context: { phase: string; name?: string; node?: unknown } }>;
  /** Request-scoped slots of other subsystems (router, head collector, transferred state). */
  slots?: Map<string, unknown>;
}

/** One unit of async work a server render waits for. */
export interface PendingWork {
  /** What the work is, for diagnostics: `query:/api/catalog`, `lazy`, `router:navigation`. */
  readonly label: string;
  /** `Date.now()` when the work was registered. */
  readonly since: number;
}

type ALSLike<T> = {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
};

// The AsyncLocalStorage instance and the fallback store are shared across
// duplicate copies of this module (as a bundler can produce under dependency
// pre-bundling) via a globalThis registry. Without sharing, each copy would
// keep its own `als`/`fallbackStore`, so `enableSSR()` in one copy would not be
// seen by `isSSR()` in another — letting effects run on the server, or leaking
// per-request state. The first copy runs the (one-time) ALS detection and
// publishes the shared state; later copies reuse it.
interface SSRShared {
  als: ALSLike<SSRStore> | null;
  fallbackStore: SSRStore;
  /**
   * How many `runInSSRContext` scopes are active on the FALLBACK path.
   *
   * With AsyncLocalStorage, "is a request active" is answered by whether the
   * store exists. Without it there is only the one shared store, so the depth
   * is what distinguishes "inside a request, mutating the shared store under
   * save/restore" from "no request at all, and the store IS the process
   * global". Subsystems that own request-scoped state need that distinction:
   * writing to the process global because no request could be identified is the
   * exact bleed request scoping exists to prevent.
   */
  fallbackDepth: number;
}
const SSR_KEY = Symbol.for("sibujs.ssr.v1");

function detectSSRShared(): SSRShared {
  let detected: ALSLike<SSRStore> | null = null;
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
      } else if (typeof require === "function") {
        // Older Node (< 22.3) has no `getBuiltinModule`. In the CommonJS build
        // `require` is a MODULE-LOCAL binding, so it has to be referenced
        // lexically. The previous attempt went through
        // `Function("return typeof require === 'function' ? require : null")`,
        // which evaluates its body in GLOBAL scope — where `require` does not
        // exist in either module system. That fallback therefore returned null
        // on every Node version and in both formats, so ALS was only ever
        // detected via `getBuiltinModule`, i.e. on Node >= 22.3.
        //
        // In the ESM build `require` is genuinely absent, so `typeof require`
        // is "undefined" and this branch is skipped — there is no synchronous
        // way to load a builtin from ESM before `getBuiltinModule` existed.
        // ESM on Node < 22.3 consequently still falls back to the shared store;
        // see NODE-002 and docs/support-matrix.md. (NODE-002)
        mod = require("node:async_hooks") as AHMod;
      }
      if (mod) detected = new mod.AsyncLocalStorage();
    }
  } catch {
    detected = null;
  }
  /* v8 ignore stop */
  return {
    als: detected,
    fallbackStore: { ssr: false, suspenseIdCounter: 0, locale: undefined },
    fallbackDepth: 0,
  };
}

const _shared: SSRShared = ((globalThis as typeof globalThis & { [SSR_KEY]?: SSRShared })[SSR_KEY] ??=
  detectSSRShared());
// Stable module-local aliases: `als` is never reassigned after detection, and
// `fallbackStore` is a shared object every copy mutates/reads in place.
const als = _shared.als;
const fallbackStore = _shared.fallbackStore;
// A copy published by an earlier build of this module may predate the field.
_shared.fallbackDepth ??= 0;

// Warn once, on a Node runtime that reached the shared-store fallback.
//
// Without AsyncLocalStorage the fallback save/restore is correct for a fully
// SYNCHRONOUS render, but two requests that interleave across an `await` share
// one store — which is cross-request data bleed, the exact failure request
// scoping exists to prevent. On a browser or a DOM-less edge runtime the
// fallback is expected and no warning is useful, so this fires only where ALS
// was supposed to be available: Node.
//
// Reachable on Node < 22.3 under ESM, where no synchronous way to load a
// builtin module exists. See NODE-002 and docs/support-matrix.md.
let _alsWarned = false;
function warnMissingAsyncLocalStorage(): void {
  if (_alsWarned || als) return;
  const isNode = typeof process !== "undefined" && !!process.versions?.node;
  if (!isNode) return;
  _alsWarned = true;
  const version = process.versions.node;
  devWarn(
    `SSR request isolation is UNAVAILABLE on this runtime (Node ${version}). ` +
      "AsyncLocalStorage could not be loaded, so concurrent requests share one " +
      "SSR store: request state and the query cache can bleed between them. " +
      "Node >= 22.3 is required for isolated SSR under ESM; the CommonJS build " +
      "works on older versions. A fully synchronous render is unaffected.",
  );
}

/** Returns the active store (ALS or fallback). */
export function getSSRStore(): SSRStore {
  if (als) {
    const s = als.getStore();
    if (s) return s;
  }
  return fallbackStore;
}

/**
 * The store belonging to the CURRENT request, or `null` when there is none.
 *
 * Deliberately different from `getSSRStore()`, which returns the process-global
 * fallback when no request is active. A subsystem that owns request-scoped
 * state must be able to tell those apart: silently writing request state into
 * the fallback is cross-request bleed, not a graceful degradation.
 *
 * Note this is NOT the same question as `isSSR()`. `enableSSR()` sets a flag on
 * whatever store is current — including the process global — whereas a request
 * scope is exactly what `runInSSRContext` establishes.
 */
export function getRequestStore(): SSRStore | null {
  if (als) return als.getStore() ?? null;
  // Without AsyncLocalStorage there is one shared store, which `runInSSRContext`
  // mutates under save/restore. Inside such a scope it is the closest thing to a
  // request store this runtime has; outside one it is the process global and
  // must not be treated as request-scoped. The documented limitation is
  // unchanged: two requests interleaving across an `await` still share it.
  return _shared.fallbackDepth > 0 ? fallbackStore : null;
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

/**
 * A request-scoped slot for a subsystem (the SSR router, the head collector,
 * transferred state), or `undefined` outside a request scope.
 *
 * @param name Subsystem key.
 * @param create Builds the slot's value the first time it is read in a request.
 */
export function requestSlot<T>(name: string, create?: () => T): T | undefined {
  const store = getRequestStore();
  if (!store) return undefined;
  const slots = (store.slots ??= new Map());
  if (!slots.has(name) && create) slots.set(name, create());
  return slots.get(name) as T | undefined;
}

const PRERENDER_HOST = Symbol.for("sibujs.prerender.v1");

/**
 * True while the code runs on a server: inside an SSR scope (`runInSSRContext`,
 * `withSSR`, `enableSSR`) or in the build-time pre-renderer. Use it to keep
 * browser-only work (canvas, `document.fonts`, storage, `matchMedia`) out of a
 * server render; `ClientOnly` and `onMount` are usually the better tools.
 *
 * @returns `true` on the server, `false` in a browser.
 */
export function isServer(): boolean {
  return getSSRStore().ssr || (globalThis as Record<symbol, unknown>)[PRERENDER_HOST] !== undefined;
}

/**
 * The opposite of {@link isServer}: true in a browser (or a browser-like test
 * environment) that is not rendering for a server.
 *
 * @returns `true` in a browser, `false` on the server.
 */
export function isClient(): boolean {
  return !isServer();
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
  const store: SSRStore = {
    ssr: true,
    suspenseIdCounter: 0,
    idCounter: 0,
    locale: undefined,
    pending: new Set(),
    wake: null,
  };
  if (als) {
    return als.run(store, fn);
  }
  warnMissingAsyncLocalStorage();
  // Module-global fallback for runtimes without AsyncLocalStorage (browser,
  // some edge runtimes). Unreachable under the Node test runner where `als`
  // is always present.
  /* v8 ignore next 12 */
  const prev = { ...fallbackStore };
  Object.assign(fallbackStore, store);
  _shared.fallbackDepth++;
  try {
    return fn();
  } finally {
    _shared.fallbackDepth--;
    for (const key of Object.keys(fallbackStore) as (keyof SSRStore)[]) {
      if (!(key in prev)) delete fallbackStore[key];
    }
    Object.assign(fallbackStore, prev);
  }
}

/**
 * Register async work the current server render must wait for.
 *
 * A no-op outside a request scope (`runInSSRContext`), so client code pays one
 * store lookup. Returns `promise` unchanged, so it can wrap a call in place.
 * A hostile thenable is adopted once through `Promise.resolve`; its rejection
 * is the caller's to handle and is not observed here beyond settling the entry.
 *
 * @param promise The work to wait for.
 * @param label Shown in `settled()` diagnostics when the work outlives the timeout.
 * @param hydration Also hold an adopting hydration in the browser (default).
 * Data fetches pass `false`: the structure they change is already rendered.
 * @returns `promise`.
 */
export function trackPending<T>(promise: T, label: string, hydration = true): T {
  const store = getRequestStore();
  // In a browser, an adopting hydration waits for structural work (a lazy
  // chunk, a route load) before it releases the server markup it did not claim.
  const target = store?.pending ? store : hydration ? hydrationPending() : null;
  const pending = target?.pending;
  if (!target || !pending) return promise;
  const entry: PendingWork = { label, since: Date.now() };
  pending.add(entry);
  const done = () => {
    pending.delete(entry);
    target.wake?.();
  };
  try {
    Promise.resolve(promise).then(done, done);
  } catch {
    done();
  }
  return promise;
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
