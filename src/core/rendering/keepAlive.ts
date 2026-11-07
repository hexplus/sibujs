import { bindOwnerScope, captureFrozen, structuralBinding } from "../../reactivity/track";
import { devWarn, isDev } from "../dev";
import { dispose, registerDisposer } from "./dispose";
import { collectRange, liveRange, queueFirstRender, rangeStarts, registerRange, resumePending } from "./range";
import { requireDocument } from "./requireDocument";

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
  requireDocument();
  const anchor = document.createComment("keep-alive");
  const cache = new Map<string, CachedCase>();
  const lruOrder: string[] = [];
  // Default to a bounded cache (10). Pass { max: 0 } explicitly for unbounded.
  const max = options?.max ?? 10;
  if (max === 0 && isDev()) {
    devWarn("KeepAlive: unbounded cache (max: 0). Cached subtrees will never be evicted — set `max` to bound memory.");
  }

  let currentKey: string | undefined;
  let current: CachedCase | null = null;
  let initialized = false;
  let disposed = false;

  const update = () => {
    if (disposed) return;
    const key = activeKey();

    const parent = anchor.parentNode;
    if (!parent) return;

    // Skip if same key
    if (initialized && key === currentKey) return;

    // Detach the shown case (WITHOUT disposing — keep reactive bindings alive)
    if (current !== null) parkCase(current);
    current = null;
    // Parking (a custom element's `disconnectedCallback`) and the factory
    // below run application code that may dispose the anchor: its teardown
    // released what was cached by then, and nothing more is built or
    // committed. Later steps need no check: the new case is cached by then,
    // so the teardown releases it, and its nested renderers guard their own
    // first render.
    if (disposed) return;

    currentKey = key;

    // Retrieve from cache or create new
    let entry = cache.get(key);
    if (!entry) {
      const factory = cases[key];
      if (!factory) {
        initialized = true;
        return;
      }
      entry = cacheCase(factory());
      // The factory disposed the anchor: the case never reached the cache, so
      // the teardown could not release it.
      if (disposed) return releaseCase(entry);
      cache.set(key, entry);
      lruOrder.push(key);

      // Evict oldest if over max
      if (max > 0 && lruOrder.length > max) {
        const evictKey = lruOrder.shift()!;
        const evicted = cache.get(evictKey);
        if (evicted) {
          cache.delete(evictKey);
          releaseCase(evicted);
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

    // Insert the case's complete range after the anchor: everything parked,
    // including what its renderers added meanwhile (they render next to their
    // anchor, in the park). Then a nested renderer whose first render found it
    // unattached runs it.
    parent.insertBefore(entry.park, anchor.nextSibling);
    resumePending(entry.starts);
    current = entry;
    initialized = true;
  };

  // Structural: cached branches are owned by this binding, so a branch
  // evicted by a switch is disposed before its bindings can re-run in the same
  // flush. (A branch that is merely detached stays live by design.)
  // Owner-stamped with the anchor, like the directives: a failure on a later
  // run is located there (and reaches an enclosing ErrorBoundary), and a held
  // detached subtree containing the anchor (`holdSubtree`, a Suspense result
  // kept while its branch is paused) holds this binding with the rest of it,
  // keeping its pending work for the resume.
  const binding = structuralBinding(update, anchor);
  // The shown case sits after the anchor; an enclosing directive branch that
  // holds this anchor takes it along. The range ends at the last start still
  // next to the anchor, or the range that start renders (`rangeEnd` follows
  // it from there). Scanned from the end: a case can have many starts.
  registerRange(anchor, () => {
    const starts = current?.starts ?? [];
    for (let i = starts.length; i--; ) if (starts[i].parentNode === anchor.parentNode) return starts[i];
    return null;
  });
  const untrack = binding.stop;

  if (!initialized) {
    // Not in a subtree that froze before the first render could run.
    const frozen = captureFrozen();
    queueFirstRender(
      anchor,
      bindOwnerScope(() => {
        if (!initialized && anchor.parentNode) binding.run(update);
      }),
      frozen,
    );
  }

  // When the anchor is disposed (via when/match/each/dispose), tear down the
  // track() subscription AND dispose every cached subtree — including the
  // currently-detached one, which would otherwise leak its bindings.
  registerDisposer(anchor, () => {
    disposed = true;
    untrack();
    const entries = [...cache.values()];
    cache.clear();
    lruOrder.length = 0;
    current = null;
    for (const entry of entries) releaseCase(entry);
  });

  return anchor;
}

/**
 * One cached case. Its content is a sibling RANGE, not a single node: a
 * `when()` / `each()` / `match()` root is a comment whose visible content
 * follows it as siblings, and a fragment contributes each of its children
 * (some of which may be such anchors). Moving only the root node would leave
 * that content behind on the page.
 */
interface CachedCase {
  /** What the factory returned; a fragment keeps its own cleanups. */
  source: Node;
  /** The top-level nodes the case renders, each possibly the start of a range. */
  starts: Node[];
  /** Holds the complete range while the case is detached. */
  park: DocumentFragment;
}

function cacheCase(node: Node): CachedCase {
  const park = document.createDocumentFragment();
  // A fragment is emptied when inserted: its canonical starts are recorded
  // first (see `rangeStarts`).
  const starts = rangeStarts(node);
  // First adoption: a start already rendering its range elsewhere brings it
  // along (see `liveRange`). One node at a time: a spread is bounded by the
  // engine's argument limit.
  for (const n of liveRange(starts)) park.appendChild(n);
  return { source: node, starts, park };
}

/**
 * Detach the case's complete range into its park, keeping it alive. Read live
 * from the starts (nested ranges included); a start removed since adoption is
 * no longer the case's.
 */
function parkCase(entry: CachedCase): void {
  for (const n of collectRange(entry.starts)) entry.park.appendChild(n);
}

/** Dispose the case's complete range (and the fragment's own cleanups) and remove it. */
function releaseCase(entry: CachedCase): void {
  for (const n of collectRange(entry.starts)) {
    dispose(n);
    n.parentNode?.removeChild(n);
  }
  // The fragment is empty by now, so this reaches only its own registrations.
  if (entry.source.nodeType === 11) dispose(entry.source);
}
