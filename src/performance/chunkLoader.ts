/**
 * Advanced runtime chunk loading with caching strategies for SibuJS.
 * Provides configurable caching, preloading, retry logic, and loading orchestration.
 */

import { reportError } from "../core/errors";
import { dispose } from "../core/rendering/dispose";
import { sanitizeUrl } from "../utils/sanitize";

/** Dispose every child of `el` (running reactive teardowns) then detach it. */
function clearChildren(el: Element): void {
  while (el.firstChild) {
    dispose(el.firstChild);
    el.removeChild(el.firstChild);
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChunkConfig {
  /** Maximum number of cached chunks */
  maxCacheSize?: number;
  /** Cache TTL in milliseconds (0 = no expiry) */
  cacheTTL?: number;
  /** Number of retry attempts on failure */
  retries?: number;
  /** Delay between retries in ms */
  retryDelay?: number;
  /** Timeout for chunk loading in ms */
  timeout?: number;
  /** Called when a chunk starts loading */
  onLoadStart?: (id: string) => void;
  /** Called when a chunk finishes loading */
  onLoadEnd?: (id: string) => void;
  /** Called when a chunk fails to load */
  onLoadError?: (id: string, error: Error) => void;
}

interface CacheEntry<T> {
  value: T;
  /** Time the entry was inserted. Used for TTL validity. */
  timestamp: number;
  /** Last time the entry was read. Used for LRU eviction. */
  lastAccess: number;
  accessCount: number;
}

// ─── ChunkRegistry ─────────────────────────────────────────────────────────

/**
 * Central registry for managing dynamic chunks with caching and lifecycle callbacks.
 *
 * INVALIDATION IS A PUBLICATION BARRIER
 * ------------------------------------
 * `invalidate(id)` and `clear()` used to delete cache entries and leave the
 * `pending` map untouched, so an in-flight load that started *before* the
 * invalidation still ran its `.then` afterwards and wrote the now-stale value
 * back into the cache. The sequence
 *
 *     load("a") starts → clear() → old load resolves → cache.set("a", stale)
 *
 * left `has("a") === true` holding data the caller had explicitly discarded.
 * The same load also ran `pending.delete(id)` unconditionally, so a *newer*
 * pending entry for the same id was removed by its predecessor's settlement.
 * And because the stale promise stayed in `pending`, a `load(id, freshLoader)`
 * issued after the invalidation deduplicated against it: the new loader was
 * never called and the caller received the stale value.
 *
 * OWNERSHIP IS THE PENDING ENTRY ITSELF. Each load creates an entry object and
 * installs it in `pending`; that object *is* the load's claim on the key.
 * `invalidate(id)` removes the key's entry and `clear()` removes all of them,
 * which revokes the claim without needing a generation counter or any map that
 * grows over time. On settlement a load re-reads `pending.get(id)` and only
 * publishes or cleans up when it finds its own entry still there.
 *
 * Work started before an invalidation still resolves or rejects normally *for
 * its original caller* — it simply cannot touch shared state any more. Nothing
 * is cancelled: the loader API takes no abort signal, so no cancellation is
 * claimed here.
 *
 * LIFECYCLE CALLBACKS ARE OBSERVERS
 * ---------------------------------
 * `onLoadStart` / `onLoadEnd` / `onLoadError` used to run inside the operation's
 * control flow. `onLoadStart` ran before the loader, so a throwing one stopped
 * the load from ever starting; `onLoadEnd` ran inside the `.then`, so a throwing
 * one converted a cached success into a rejection *and* then delivered the
 * observer's own error to `onLoadError`, leaving the caller told "failed" while
 * the cache held the value. Every callback now runs through `notify`, which
 * contains and reports the failure without letting it reach the operation.
 */
export function createChunkRegistry(config: ChunkConfig = {}) {
  const {
    maxCacheSize = 50,
    cacheTTL = 0,
    retries = 2,
    retryDelay = 1000,
    timeout = 10000,
    onLoadStart,
    onLoadEnd,
    onLoadError,
  } = config;

  /**
   * A load's claim on a key. Identity is the whole point: the object in the map
   * is the owner, so removing it from the map revokes ownership.
   */
  interface PendingLoad {
    promise: Promise<unknown>;
  }

  const cache = new Map<string, CacheEntry<unknown>>();
  const pending = new Map<string, PendingLoad>();
  /** id → the marker of the preload that requested it. See `preloadFn`. */
  const preloaded = new Map<string, object>();

  /**
   * Run a user lifecycle callback as a pure observer.
   *
   * A callback exception must never change what the operation did: the loader
   * still ran, the cache still holds what the loader returned, and the caller
   * still gets the loader's own result or error. The failure is reported through
   * the runtime error pipeline (boundary → configured handler → console) rather
   * than swallowed, and `reportError` is documented never to throw, so this is
   * safe to call from inside a `.then`/`.catch`.
   */
  function notify(name: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      reportError(err, { phase: "async", name: `chunkRegistry(${name})` });
    }
  }

  // True LRU eviction: drop the entry with the oldest lastAccess timestamp.
  // Loops while at-or-above max so concurrent loads can't grow the cache.
  function evict() {
    while (cache.size >= maxCacheSize) {
      let lru: string | null = null;
      let lruTime = Infinity;
      for (const [key, entry] of cache) {
        if (entry.lastAccess < lruTime) {
          lruTime = entry.lastAccess;
          lru = key;
        }
      }
      if (!lru) return;
      cache.delete(lru);
    }
  }

  // Check if cached entry is still valid
  function isValid(entry: CacheEntry<unknown>): boolean {
    if (cacheTTL === 0) return true;
    return Date.now() - entry.timestamp < cacheTTL;
  }

  // Load with retry logic
  async function loadWithRetry<T>(id: string, loader: () => Promise<T>, attempt = 0): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await (timeout > 0
        ? new Promise<T>((resolve, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error(`Chunk '${id}' loading timed out after ${timeout}ms`)),
              timeout,
            );
            loader().then(
              (v) => {
                if (timeoutHandle !== null) clearTimeout(timeoutHandle);
                resolve(v);
              },
              (e) => {
                if (timeoutHandle !== null) clearTimeout(timeoutHandle);
                reject(e);
              },
            );
          })
        : loader());
      return result;
    } catch (err) {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
        return loadWithRetry(id, loader, attempt + 1);
      }
      throw err;
    }
  }

  async function loadFn<T>(id: string, loader: () => Promise<T>): Promise<T> {
    const cached = cache.get(id);
    if (cached && isValid(cached)) {
      cached.accessCount++;
      cached.lastAccess = Date.now();
      return cached.value as T;
    }

    // Same-generation callers deduplicate. An invalidated load is no longer in
    // the map, so a post-invalidation caller starts fresh work instead of
    // adopting work whose result was already discarded.
    const existing = pending.get(id);
    if (existing) return existing.promise as Promise<T>;

    // Outside the promise chain: a throwing observer must not prevent the load.
    notify("onLoadStart", () => onLoadStart?.(id));

    const entry: PendingLoad = { promise: undefined as unknown as Promise<unknown> };
    /** Do we still own the key? Re-read every time — never cached. */
    const owns = () => pending.get(id) === entry;

    entry.promise = loadWithRetry(id, loader).then(
      (value) => {
        // Publish only while still the owner. A load superseded by invalidate()
        // or clear() resolves normally for its caller and touches nothing else —
        // in particular it does not delete a newer pending entry.
        if (owns()) {
          pending.delete(id);
          evict();
          const now = Date.now();
          cache.set(id, { value, timestamp: now, lastAccess: now, accessCount: 1 });
        }
        notify("onLoadEnd", () => onLoadEnd?.(id));
        return value;
      },
      (err) => {
        if (owns()) pending.delete(id);
        const error = err instanceof Error ? err : new Error(String(err));
        // Only genuine loader/timeout errors reach here — a callback's own
        // exception is contained by `notify` and can never arrive as one.
        notify("onLoadError", () => onLoadError?.(id, error));
        throw error;
      },
    );

    pending.set(id, entry);
    return entry.promise as Promise<T>;
  }

  function preloadFn<T>(id: string, loader: () => Promise<T>): void {
    // `preloaded` is a "requested" guard to dedupe calls. On failure the marker
    // is cleared so future preload() calls can retry — but only if it is still
    // OUR marker, so a stale preload's late failure cannot cancel the guard a
    // newer preload installed after an invalidation.
    if (cache.has(id) || pending.has(id) || preloaded.has(id)) return;
    const marker = {};
    preloaded.set(id, marker);
    loadFn(id, loader).catch(() => {
      if (preloaded.get(id) === marker) preloaded.delete(id);
    });
  }

  return {
    load: loadFn,
    preload: preloadFn,

    /**
     * Preload multiple chunks in parallel.
     */
    preloadAll(entries: Array<{ id: string; loader: () => Promise<unknown> }>): void {
      for (const entry of entries) {
        preloadFn(entry.id, entry.loader);
      }
    },

    /**
     * Check if a chunk is cached and valid.
     */
    has(id: string): boolean {
      const entry = cache.get(id);
      return !!entry && isValid(entry);
    },

    /**
     * Get a cached chunk synchronously. Returns undefined if not cached.
     */
    get<T>(id: string): T | undefined {
      const entry = cache.get(id);
      if (entry && isValid(entry)) {
        entry.accessCount++;
        entry.lastAccess = Date.now();
        return entry.value as T;
      }
      return undefined;
    },

    /**
     * Invalidate a cached chunk, and supersede any load still in flight for it.
     *
     * In-flight work is not cancelled — the loader API takes no abort signal, so
     * claiming cancellation would be a lie. It is *superseded*: it still settles
     * for whoever called `load()`, but it can no longer write to the cache, and
     * a subsequent `load(id, …)` starts fresh work rather than adopting it.
     */
    invalidate(id: string): void {
      cache.delete(id);
      preloaded.delete(id);
      pending.delete(id);
    },

    /**
     * Clear all cached chunks, and supersede every load still in flight.
     *
     * Same barrier as `invalidate`, applied to every key at once.
     */
    clear(): void {
      cache.clear();
      preloaded.clear();
      pending.clear();
    },

    /**
     * Get cache statistics.
     *
     * Describes currently OWNED state: superseded loads are already absent from
     * `pending`, so the counts never include work whose result will be discarded.
     */
    stats(): {
      size: number;
      maxSize: number;
      pending: number;
      preloaded: number;
    } {
      return {
        size: cache.size,
        maxSize: maxCacheSize,
        pending: pending.size,
        preloaded: preloaded.size,
      };
    },
  };
}

// ─── Lazy Component with Chunk Registry ─────────────────────────────────────

/**
 * Create a lazy-loaded component that uses the chunk registry for caching.
 * Provides automatic retry, timeout, and cache management.
 */
export function lazyChunk(
  id: string,
  loader: () => Promise<{ default: () => HTMLElement } | (() => HTMLElement)>,
  registry: ReturnType<typeof createChunkRegistry>,
  fallback?: () => HTMLElement,
): () => HTMLElement {
  return () => {
    // Check if already cached
    const cached = registry.get<() => HTMLElement>(id);
    if (cached) return cached();

    // Show fallback while loading
    const container = document.createElement("div");
    container.setAttribute("data-chunk", id);

    if (fallback) {
      container.appendChild(fallback());
    }

    registry
      .load(id, async () => {
        const mod = await loader();
        return typeof mod === "function" ? mod : (mod as { default: () => HTMLElement }).default;
      })
      .then((component) => {
        clearChildren(container);
        container.appendChild(component());
      })
      .catch((err) => {
        clearChildren(container);
        const errorEl = document.createElement("div");
        errorEl.textContent = `Failed to load chunk '${id}': ${err.message}`;
        container.appendChild(errorEl);
      });

    return container;
  };
}

// ─── Module Preloader ───────────────────────────────────────────────────────

/**
 * Preload ES modules using link[rel=modulepreload].
 * Improves loading performance by informing the browser early.
 */
export function preloadModule(url: string): void {
  if (typeof document === "undefined") return;
  // Defense-in-depth: refuse dangerous schemes (javascript:/data:/blob:) before
  // priming a module preload, consistent with platform/head.ts.
  const safe = sanitizeUrl(url);
  if (!safe) return;
  // Escape the (sanitized) URL before embedding it in the dedup attribute
  // selector. A value containing `"`, `]`, or other selector metacharacters
  // would otherwise throw a SyntaxError or match the wrong link (CSS-selector
  // injection, CWE-74). Mirrors the guard used in plugins/startup.ts.
  const safeHref =
    typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(safe) : safe.replace(/["\\]/g, "\\$&");
  const existing = document.querySelector(`link[rel="modulepreload"][href="${safeHref}"]`);
  if (existing) return;
  const link = document.createElement("link");
  link.rel = "modulepreload";
  link.href = safe;
  document.head.appendChild(link);
}

/**
 * Preload multiple modules.
 */
export function preloadModules(urls: string[]): void {
  urls.forEach(preloadModule);
}
