import { track } from "../../reactivity/track";
import { devWarn, isDev } from "../dev";
import { dispose, registerDisposer } from "./dispose";

/**
 * Options for KeepAlive.
 */
export interface KeepAliveOptions {
  /** Maximum cached components. Oldest evicted (and disposed) when exceeded. */
  max?: number;
}

/**
 * Caches component DOM subtrees by key, preserving reactive bindings
 * when switching between views. Unlike `when()`/`match()`, toggling
 * does NOT dispose the previous branch — it detaches and stashes it,
 * so signals, effects, scroll position, and form state survive.
 *
 * When a key is evicted (via `max` limit), its subtree is properly
 * disposed to free reactive subscriptions.
 *
 * @param activeKey Reactive getter returning the current active key
 * @param cases Map of key → factory function that creates the component
 * @param options Optional: `{ max }` to cap cache size
 * @returns A Comment anchor node (same pattern as `when`, `match`, `each`)
 *
 * @example
 * ```ts
 * const [tab, setTab] = signal("home");
 *
 * KeepAlive(
 *   () => tab(),
 *   {
 *     home: () => HomePage(),
 *     settings: () => SettingsPage(),
 *     profile: () => ProfilePage(),
 *   },
 *   { max: 5 }
 * );
 * ```
 */
export function KeepAlive(
  activeKey: () => string,
  cases: Record<string, () => Node>,
  options?: KeepAliveOptions,
): Comment {
  const anchor = document.createComment("keep-alive");
  const cache = new Map<string, Node>();
  const lruOrder: string[] = [];
  // Default to a bounded cache (10). Pass { max: 0 } explicitly for unbounded.
  const max = options?.max ?? 10;
  if (max === 0 && isDev()) {
    devWarn("KeepAlive: unbounded cache (max: 0). Cached subtrees will never be evicted — set `max` to bound memory.");
  }

  let currentKey: string | undefined;
  let currentNode: Node | null = null;
  let initialized = false;
  let disposed = false;

  const update = () => {
    if (disposed) return;
    const key = activeKey();

    const parent = anchor.parentNode;
    if (!parent) return;

    // Skip if same key
    if (initialized && key === currentKey) return;

    // Detach current node (WITHOUT disposing — keep reactive bindings alive)
    if (currentNode?.parentNode) {
      parent.removeChild(currentNode);
    }

    currentKey = key;

    // Retrieve from cache or create new
    let node = cache.get(key);
    if (!node) {
      const factory = cases[key];
      if (!factory) {
        currentNode = null;
        initialized = true;
        return;
      }
      node = factory();
      cache.set(key, node);
      lruOrder.push(key);

      // Evict oldest if over max
      if (max > 0 && lruOrder.length > max) {
        const evictKey = lruOrder.shift()!;
        const evictNode = cache.get(evictKey);
        if (evictNode) {
          dispose(evictNode);
          if (evictNode.parentNode) evictNode.parentNode.removeChild(evictNode);
          cache.delete(evictKey);
        }
      }
    } else {
      // Move to end of LRU (most recently used)
      const idx = lruOrder.indexOf(key);
      if (idx !== -1) {
        lruOrder.splice(idx, 1);
        lruOrder.push(key);
      }
    }

    // Insert cached/new node after anchor
    parent.insertBefore(node, anchor.nextSibling);
    currentNode = node;
    initialized = true;
  };

  const untrack = track(update);

  if (!initialized) {
    queueMicrotask(() => {
      if (!initialized && anchor.parentNode) update();
    });
  }

  // When the anchor is disposed (via when/match/each/dispose), tear down the
  // track() subscription AND dispose every cached subtree — including the
  // currently-detached one, which would otherwise leak its bindings.
  registerDisposer(anchor, () => {
    disposed = true;
    untrack();
    for (const node of cache.values()) {
      dispose(node);
      if (node.parentNode) node.parentNode.removeChild(node);
    }
    cache.clear();
    lruOrder.length = 0;
    currentNode = null;
  });

  return anchor;
}
