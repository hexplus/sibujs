// ============================================================================
// DOM RECYCLING & RESOURCE PRELOADING
// ============================================================================

import { devWarn, isDev } from "../core/dev";

const _isDev = isDev();

/**
 * DOMPool manages a pool of reusable DOM elements to reduce GC pressure.
 */
export class DOMPool {
  private pools = new Map<string, HTMLElement[]>();
  private maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  /**
   * Get a recycled element or create a new one.
   */
  acquire(tag: string): HTMLElement {
    const pool = this.pools.get(tag);
    if (pool && pool.length > 0) {
      const el = pool.pop() as HTMLElement;
      return el;
    }
    return document.createElement(tag);
  }

  /**
   * Return an element to the pool for reuse.
   * Clears attributes, children, and event listeners.
   *
   * Contract: the caller MUST detach the element from the DOM (and run any
   * `dispose()` on bound reactive subscriptions) BEFORE calling `release()`.
   * Releasing a connected element leaves it visible while it is mutated and
   * is almost certainly a bug.
   */
  release(element: HTMLElement): void {
    if (_isDev && element.isConnected) {
      devWarn(
        "DOMPool.release() called on a still-connected element. Detach it from the DOM first (remove() / dispose()).",
      );
    }
    const tag = element.tagName.toLowerCase();
    let pool = this.pools.get(tag);
    if (!pool) {
      pool = [];
      this.pools.set(tag, pool);
    }

    if (pool.length >= this.maxSize) return;

    // Clean the element for reuse
    element.innerHTML = "";
    element.className = "";
    element.removeAttribute("style");
    element.removeAttribute("id");

    // Remove all attributes except tag-intrinsic ones
    const attrs = Array.from(element.attributes);
    for (const attr of attrs) {
      element.removeAttribute(attr.name);
    }

    // Clone to detach event listeners
    const clean = element.cloneNode(false) as HTMLElement;
    pool.push(clean);
  }

  /**
   * Clear all pools.
   */
  clear(): void {
    this.pools.clear();
  }

  /**
   * Get pool statistics.
   */
  stats(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [tag, pool] of this.pools) {
      result[tag] = pool.length;
    }
    return result;
  }
}

/**
 * Lazily obtain the shared default DOMPool instance.
 * Avoids the side effect of constructing a pool at module load time —
 * callers that never recycle DOM pay no allocation cost.
 */
let _defaultPool: DOMPool | null = null;
export function getDOMPool(): DOMPool {
  if (_defaultPool === null) _defaultPool = new DOMPool();
  return _defaultPool;
}

// ============================================================================
// RESOURCE PRELOADING
// ============================================================================

const preloadedResources = new Set<string>();

/**
 * Preloads a resource (script, style, or generic fetch).
 */
export function preloadResource(url: string, type: "script" | "style" | "fetch" | "image" = "fetch"): void {
  if (preloadedResources.has(url)) return;
  preloadedResources.add(url);

  const link = document.createElement("link");
  link.rel = "preload";
  link.href = url;

  switch (type) {
    case "script":
      link.setAttribute("as", "script");
      break;
    case "style":
      link.setAttribute("as", "style");
      break;
    case "image":
      link.setAttribute("as", "image");
      break;
    default:
      link.setAttribute("as", "fetch");
      link.setAttribute("crossorigin", "anonymous");
  }

  document.head.appendChild(link);
}

/**
 * Prefetches a URL for future navigation.
 */
export function prefetch(url: string): void {
  if (preloadedResources.has(url)) return;
  preloadedResources.add(url);

  const link = document.createElement("link");
  link.rel = "prefetch";
  link.href = url;
  document.head.appendChild(link);
}

/**
 * Preloads an image and returns a promise that resolves when loaded.
 */
export function preloadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
