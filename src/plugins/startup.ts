// ============================================================================
// STARTUP OPTIMIZATIONS
// ============================================================================

/**
 * Startup optimization utilities for SibuJS applications.
 * Provides critical path optimization, route prerendering, and SSR caching.
 */

import { reportError } from "../core/errors";
import { renderToString } from "../platform/ssr";

// ─── Critical Resource Preloader ────────────────────────────────────────────

/**
 * Critical resource preloader — ensures key assets are loaded before rendering.
 * Generates <link rel="preload"> tags for critical resources and appends them
 * to the document head.
 */
export function preloadCritical(
  resources: Array<{
    href: string;
    as: "script" | "style" | "font" | "image" | "fetch";
    type?: string;
    crossOrigin?: "anonymous" | "use-credentials";
  }>,
): void {
  if (typeof document === "undefined") return;

  for (const resource of resources) {
    // Skip if a preload link for this href already exists.
    // Use CSS.escape to safely embed arbitrary URLs in the attribute selector
    // (hrefs may contain quotes, brackets, or other special characters).
    const safeHref =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(resource.href)
        : resource.href.replace(/["\\]/g, "\\$&");
    const existing = document.querySelector(`link[rel="preload"][href="${safeHref}"]`);
    if (existing) continue;

    const link = document.createElement("link");
    link.rel = "preload";
    link.href = resource.href;
    link.setAttribute("as", resource.as);

    if (resource.type) {
      link.type = resource.type;
    }

    if (resource.crossOrigin) {
      link.crossOrigin = resource.crossOrigin;
    }

    document.head.appendChild(link);
  }
}

// ─── Route Prerenderer ──────────────────────────────────────────────────────

interface PrerenderCacheEntry {
  html: string;
  timestamp: number;
}

/**
 * Validate a cache size limit. `0` disables caching; negative, fractional and
 * non-finite limits are rejected rather than silently behaving as some other
 * bound.
 */
function assertCacheSize(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`[Startup] ${name} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Make room to insert `key` into a timestamped cache without exceeding
 * `maxSize`. Returns false when the cache cannot hold anything (`maxSize` 0).
 *
 * Overwriting an existing key needs no room, so nothing is evicted — evicting
 * first used to discard an unrelated entry on every update at capacity. For a
 * new key, expired entries go first, then the oldest valid ones (compared with
 * `!== null`, so an oldest key of "" is evicted too).
 */
function makeRoomFor<E extends { timestamp: number }>(
  cache: Map<string, E>,
  key: string,
  maxSize: number,
  isValid: (entry: E) => boolean,
): boolean {
  if (maxSize === 0) return false;
  if (cache.has(key)) return true;
  if (cache.size < maxSize) return true;

  for (const [k, entry] of cache) {
    if (!isValid(entry)) cache.delete(k);
  }

  while (cache.size >= maxSize) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, entry] of cache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey === null) break;
    cache.delete(oldestKey);
  }
  return true;
}

/**
 * Prerender a set of routes for instant navigation.
 * Renders components to HTML using `renderToString` and caches them.
 * Supports TTL-based expiry and maximum cache size limits.
 */
export function prerenderRoutes(
  routes: Array<{ path: string; component: () => HTMLElement }>,
  options?: { maxCacheSize?: number; cacheTTL?: number },
) {
  const maxCacheSize = options?.maxCacheSize ?? 50;
  const cacheTTL = options?.cacheTTL ?? 0; // 0 = no expiry
  assertCacheSize("maxCacheSize", maxCacheSize);

  const cache = new Map<string, PrerenderCacheEntry>();

  function isValid(entry: PrerenderCacheEntry): boolean {
    if (cacheTTL === 0) return true;
    return Date.now() - entry.timestamp < cacheTTL;
  }

  // Prerender all provided routes immediately. With caching disabled
  // (`maxCacheSize: 0`) there is nowhere to keep the HTML, so nothing is rendered.
  for (const route of routes) {
    if (!makeRoomFor(cache, route.path, maxCacheSize, isValid)) break;
    const html = renderToString(route.component());
    cache.set(route.path, { html, timestamp: Date.now() });
  }

  return {
    /** Get cached HTML for a route, or undefined if not cached or expired */
    get(path: string): string | undefined {
      const entry = cache.get(path);
      if (!entry) return undefined;
      if (!isValid(entry)) {
        cache.delete(path);
        return undefined;
      }
      return entry.html;
    },

    /** Check if a route has been prerendered and is still valid */
    has(path: string): boolean {
      const entry = cache.get(path);
      if (!entry) return false;
      if (!isValid(entry)) {
        cache.delete(path);
        return false;
      }
      return true;
    },

    /** Invalidate a cached route */
    invalidate(path: string): void {
      cache.delete(path);
    },

    /** Clear all cached routes */
    clear(): void {
      cache.clear();
    },

    /** Get cache statistics */
    stats(): { size: number; routes: string[] } {
      // Clean up expired entries first
      if (cacheTTL > 0) {
        for (const [key, entry] of cache) {
          if (!isValid(entry)) {
            cache.delete(key);
          }
        }
      }

      return {
        size: cache.size,
        routes: Array.from(cache.keys()),
      };
    },
  };
}

// ─── SSR Response Cache ─────────────────────────────────────────────────────

interface SSRCacheEntry {
  html: string;
  timestamp: number;
  ttl: number;
}

/**
 * SSR response cache for frequently accessed routes.
 * Supports TTL-based expiry and max size limits.
 * Tracks hit/miss statistics for monitoring.
 */
export function createSSRCache(config?: { maxSize?: number; defaultTTL?: number }) {
  const maxSize = config?.maxSize ?? 100;
  const defaultTTL = config?.defaultTTL ?? 60000; // 1 minute default
  assertCacheSize("maxSize", maxSize);

  const cache = new Map<string, SSRCacheEntry>();
  let hits = 0;
  let misses = 0;

  function isValid(entry: SSRCacheEntry): boolean {
    if (entry.ttl === 0) return true; // 0 = no expiry
    return Date.now() - entry.timestamp < entry.ttl;
  }

  return {
    /** Get cached HTML for a key, or undefined if not cached or expired */
    get(key: string): string | undefined {
      const entry = cache.get(key);
      if (!entry) {
        misses++;
        return undefined;
      }
      if (!isValid(entry)) {
        cache.delete(key);
        misses++;
        return undefined;
      }
      hits++;
      return entry.html;
    },

    /** Cache an HTML string with an optional TTL override */
    set(key: string, html: string, ttl?: number): void {
      if (!makeRoomFor(cache, key, maxSize, isValid)) return;
      cache.set(key, {
        html,
        timestamp: Date.now(),
        ttl: ttl ?? defaultTTL,
      });
    },

    /** Check if a key exists in the cache and is still valid */
    has(key: string): boolean {
      const entry = cache.get(key);
      if (!entry) return false;
      if (!isValid(entry)) {
        cache.delete(key);
        return false;
      }
      return true;
    },

    /** Invalidate a cached entry */
    invalidate(key: string): void {
      cache.delete(key);
    },

    /** Clear all cached entries and reset statistics */
    clear(): void {
      cache.clear();
      hits = 0;
      misses = 0;
    },

    /** Get cache statistics including hit/miss counts */
    stats(): { size: number; hits: number; misses: number } {
      return { size: cache.size, hits, misses };
    },
  };
}

// ─── Defer Non-Critical Work ────────────────────────────────────────────────

/** Upper bound on how long deferred work waits for an idle period. */
const DEFER_IDLE_TIMEOUT_MS = 2000;

/**
 * Measure and optimize Time to Interactive (TTI).
 * Defers non-critical work until after the main thread is idle.
 * Uses `requestIdleCallback` when available, falling back to `setTimeout`.
 */
export function deferNonCritical(tasks: Array<() => void>): void {
  if (tasks.length === 0) return;

  // A finite timeout makes the browser invoke the callback even on a page that
  // never goes idle; without one, deferred work could wait forever.
  const schedule: (cb: (deadline?: IdleDeadline) => void) => void =
    typeof requestIdleCallback !== "undefined"
      ? (cb) => {
          requestIdleCallback(cb, { timeout: DEFER_IDLE_TIMEOUT_MS });
        }
      : (cb) => {
          setTimeout(cb, 1);
        };

  // Copy tasks so the original array is not mutated
  const queue = [...tasks];
  let index = 0;

  function processNext(deadline?: IdleDeadline): void {
    // Every invocation runs at least one task. Rescheduling as soon as the
    // budget was under 1ms — including a timed-out callback, whose budget is
    // always 0 — could reschedule forever without doing any work. After that
    // first task, work stays chunked to the remaining idle budget.
    let ranOne = false;
    while (index < queue.length) {
      if (ranOne && deadline && deadline.timeRemaining() < 1) {
        schedule(processNext);
        return;
      }

      try {
        queue[index]();
      } catch (e) {
        // Non-critical tasks must not stop the tasks after them; the failure is
        // still reported.
        reportError(e, { phase: "scheduler", name: "deferNonCritical" });
      }
      index++;
      ranOne = true;
    }
  }

  schedule(processNext);
}

// ─── Boot Sequence ──────────────────────────────────────────────────────────

interface BootTask {
  name: string;
  task: () => void | Promise<void>;
}

/**
 * Create a boot sequence that orchestrates app initialization.
 * Critical tasks run first in registration order. Deferred tasks run
 * afterward using idle scheduling. Returns timing information and
 * any errors that occurred.
 */
export function createBootSequence() {
  const criticalTasks: BootTask[] = [];
  const deferredTasks: BootTask[] = [];

  return {
    /** Add a critical task that runs immediately during boot */
    critical(name: string, task: () => void | Promise<void>): void {
      criticalTasks.push({ name, task });
    },

    /** Add a deferred task that runs after all critical tasks complete */
    defer(name: string, task: () => void | Promise<void>): void {
      deferredTasks.push({ name, task });
    },

    /** Execute the boot sequence: critical tasks first, then deferred */
    async boot(): Promise<{
      timing: Record<string, number>;
      errors: Array<{ name: string; error: Error }>;
    }> {
      const timing: Record<string, number> = {};
      const errors: Array<{ name: string; error: Error }> = [];

      // Run critical tasks sequentially
      for (const entry of criticalTasks) {
        const start = Date.now();
        try {
          await entry.task();
        } catch (e) {
          errors.push({
            name: entry.name,
            error: e instanceof Error ? e : new Error(String(e)),
          });
        }
        timing[entry.name] = Date.now() - start;
      }

      // Run deferred tasks — still sequential but measured
      for (const entry of deferredTasks) {
        const start = Date.now();
        try {
          await entry.task();
        } catch (e) {
          errors.push({
            name: entry.name,
            error: e instanceof Error ? e : new Error(String(e)),
          });
        }
        timing[entry.name] = Date.now() - start;
      }

      return { timing, errors };
    },
  };
}
