/**
 * Advanced runtime chunk loading with caching strategies for SibuJS.
 * Provides configurable caching, preloading, retry logic, and loading orchestration.
 */

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

  const cache = new Map<string, CacheEntry<unknown>>();
  const pending = new Map<string, Promise<unknown>>();
  const preloaded = new Set<string>();

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

    const pendingLoad = pending.get(id);
    if (pendingLoad) return pendingLoad as Promise<T>;

    onLoadStart?.(id);
    const loadPromise = loadWithRetry(id, loader)
      .then((value) => {
        evict();
        const now = Date.now();
        cache.set(id, { value, timestamp: now, lastAccess: now, accessCount: 1 });
        pending.delete(id);
        onLoadEnd?.(id);
        return value;
      })
      .catch((err) => {
        pending.delete(id);
        const error = err instanceof Error ? err : new Error(String(err));
        onLoadError?.(id, error);
        throw error;
      });

    pending.set(id, loadPromise as Promise<unknown>);
    return loadPromise;
  }

  function preloadFn<T>(id: string, loader: () => Promise<T>): void {
    // `preloaded` is purely a "requested" guard to dedupe calls.
    // On failure we clear it so future preload() calls can retry.
    if (cache.has(id) || pending.has(id) || preloaded.has(id)) return;
    preloaded.add(id);
    loadFn(id, loader).catch(() => {
      preloaded.delete(id);
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
     * Invalidate a cached chunk.
     */
    invalidate(id: string): void {
      cache.delete(id);
      preloaded.delete(id);
    },

    /**
     * Clear all cached chunks.
     */
    clear(): void {
      cache.clear();
      preloaded.clear();
    },

    /**
     * Get cache statistics.
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
        container.innerHTML = "";
        container.appendChild(component());
      })
      .catch((err) => {
        container.innerHTML = "";
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
  const existing = document.querySelector(`link[href="${url}"][rel="modulepreload"]`);
  if (existing) return;
  const link = document.createElement("link");
  link.rel = "modulepreload";
  link.href = url;
  document.head.appendChild(link);
}

/**
 * Preload multiple modules.
 */
export function preloadModules(urls: string[]): void {
  urls.forEach(preloadModule);
}
