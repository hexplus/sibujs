/**
 * Lifecycle hooks for SibuJS components.
 *
 * These hooks schedule callbacks to run after the component's DOM
 * has been mounted or when it is removed from the document.
 *
 * @example
 * ```ts
 * function MyComponent() {
 *   onMount(() => {
 *     console.log("Component is in the DOM");
 *   });
 *
 *   onUnmount(() => {
 *     console.log("Component was removed");
 *   });
 *
 *   return div("Hello");
 * }
 * ```
 */

import { devWarn } from "../dev";
import { registerDisposer } from "./dispose";

type CleanupFn = () => void;

/** Safely invoke a lifecycle callback, catching and logging errors in dev mode.
 *  Returns the callback's return value (used to capture onMount cleanup functions). */
function safeCall(cb: () => unknown, hookName: string): unknown {
  try {
    return cb();
  } catch (err) {
    devWarn(`${hookName}: callback threw: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Run onMount callback and register returned cleanup function (if any) on the element. */
function runMountCallback(callback: () => undefined | CleanupFn, hookName: string, element?: HTMLElement): void {
  const cleanup = safeCall(callback, hookName);
  if (typeof cleanup === "function" && element) {
    registerDisposer(element, cleanup as CleanupFn);
  }
}

// ─── Shared module-level MutationObserver ──────────────────────────────────
// Previously each onMount/onUnmount call attached its own MutationObserver
// to document.body — O(N) observers for N lifecycle hooks. This replaces
// that with a SINGLE shared observer keyed by WeakMap<Element, callbacks[]>.
// The observer is lazily created on first registration and disconnected
// when both maps are empty.

type ConnectCb = () => void;
type DisconnectCb = () => void;

const mountWatchers = new WeakMap<Element, ConnectCb[]>();
const unmountWatchers = new WeakMap<Element, DisconnectCb[]>();
// Since WeakMap is not iterable, we track a parallel Set of elements that
// currently have watchers. Entries are removed once watchers fire/clear.
const watchedMountElements = new Set<Element>();
const watchedUnmountElements = new Set<Element>();

let sharedObserver: MutationObserver | null = null;
// Fallback counter — every N mutations, do a full sweep to catch any
// watchers that were missed due to edge cases (e.g. a watched element
// that was moved via a sequence we failed to walk into).
let mutationCounter = 0;
const FULL_SWEEP_INTERVAL = 256;

function fireMount(el: Element): void {
  const cbs = mountWatchers.get(el);
  if (!cbs) return;
  mountWatchers.delete(el);
  watchedMountElements.delete(el);
  for (const cb of cbs) {
    try {
      cb();
    } catch {
      /* already logged inside safeCall */
    }
  }
}

function fireUnmount(el: Element): void {
  const cbs = unmountWatchers.get(el);
  if (!cbs) return;
  // Defer one microtask + re-check connection. A synchronous re-parent
  // (removeChild + appendChild in the same tick) would otherwise fire a
  // false unmount because the MutationObserver sees the removal before
  // observing the addition.
  queueMicrotask(() => {
    if (el.isConnected) return;
    const stillCbs = unmountWatchers.get(el);
    if (!stillCbs) return;
    unmountWatchers.delete(el);
    watchedUnmountElements.delete(el);
    for (const cb of stillCbs) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  });
}

function visitAddedNode(node: Node): void {
  if (watchedMountElements.size === 0) return;
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
  const el = node as Element;
  // Direct hit
  if (watchedMountElements.has(el) && el.isConnected) {
    fireMount(el);
  }
  // Descendants: only walk if the added node has children (a leaf insertion
  // can't contain any watched element). For deep subtrees this is still
  // O(M) on watched count, but skipping leaf nodes is the dominant win.
  if (el.firstElementChild) {
    for (const watched of Array.from(watchedMountElements)) {
      if (watched !== el && watched.isConnected && el.contains(watched)) {
        fireMount(watched);
      }
    }
  }
}

function visitRemovedNode(node: Node): void {
  if (watchedUnmountElements.size === 0) return;
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
  const el = node as Element;
  if (watchedUnmountElements.has(el) && !el.isConnected) {
    fireUnmount(el);
  }
  if (el.firstElementChild) {
    for (const watched of Array.from(watchedUnmountElements)) {
      if (watched !== el && !watched.isConnected && el.contains(watched)) {
        fireUnmount(watched);
      }
    }
  }
}

function fullSweep(): void {
  if (watchedMountElements.size > 0) {
    for (const el of Array.from(watchedMountElements)) {
      if (el.isConnected) fireMount(el);
    }
  }
  if (watchedUnmountElements.size > 0) {
    for (const el of Array.from(watchedUnmountElements)) {
      if (!el.isConnected) fireUnmount(el);
    }
  }
}

function ensureObserver(): void {
  if (sharedObserver || typeof document === "undefined") return;
  sharedObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type !== "childList") continue;
      if (m.addedNodes.length > 0) {
        for (let i = 0; i < m.addedNodes.length; i++) {
          visitAddedNode(m.addedNodes[i]!);
        }
      }
      if (m.removedNodes.length > 0) {
        for (let i = 0; i < m.removedNodes.length; i++) {
          visitRemovedNode(m.removedNodes[i]!);
        }
      }
    }
    // Periodic fallback in case descendant tracking missed something.
    mutationCounter += mutations.length;
    if (mutationCounter >= FULL_SWEEP_INTERVAL) {
      mutationCounter = 0;
      fullSweep();
    }
    maybeDisconnectObserver();
  });
  sharedObserver.observe(document.body, { childList: true, subtree: true });
}

function maybeDisconnectObserver(): void {
  if (!sharedObserver) return;
  if (watchedMountElements.size === 0 && watchedUnmountElements.size === 0) {
    sharedObserver.disconnect();
    sharedObserver = null;
    mutationCounter = 0;
  }
}

function registerMountWatcher(element: Element, cb: ConnectCb): () => void {
  let list = mountWatchers.get(element);
  if (!list) {
    list = [];
    mountWatchers.set(element, list);
  }
  list.push(cb);
  watchedMountElements.add(element);
  ensureObserver();
  return () => {
    const cbs = mountWatchers.get(element);
    if (cbs) {
      const idx = cbs.indexOf(cb);
      if (idx !== -1) cbs.splice(idx, 1);
      if (cbs.length === 0) {
        mountWatchers.delete(element);
        watchedMountElements.delete(element);
      }
    }
    maybeDisconnectObserver();
  };
}

function registerUnmountWatcher(element: Element, cb: DisconnectCb): () => void {
  let list = unmountWatchers.get(element);
  if (!list) {
    list = [];
    unmountWatchers.set(element, list);
  }
  list.push(cb);
  watchedUnmountElements.add(element);
  ensureObserver();
  return () => {
    const cbs = unmountWatchers.get(element);
    if (cbs) {
      const idx = cbs.indexOf(cb);
      if (idx !== -1) cbs.splice(idx, 1);
      if (cbs.length === 0) {
        unmountWatchers.delete(element);
        watchedUnmountElements.delete(element);
      }
    }
    maybeDisconnectObserver();
  };
}

/**
 * Runs a callback once the component's element has been inserted into the DOM.
 * Uses queueMicrotask to defer execution until after the current synchronous
 * rendering pass completes.
 *
 * Optionally returns a cleanup function that will be called on unmount
 * (if you also use onUnmount, prefer that for explicit cleanup).
 *
 * @param callback Function to run after mount. May return a cleanup function.
 * @param element Optional element to observe; if provided, waits until it's connected.
 */
export function onMount(callback: () => undefined | CleanupFn, element?: HTMLElement): void {
  // No-op during SSR — lifecycle hooks are client-only
  if (typeof document === "undefined") return;

  if (element) {
    // Disposed flag — if the element is disposed before it ever connects,
    // the microtask must not register an observer watcher.
    let disposed = false;
    registerDisposer(element, () => {
      disposed = true;
    });

    if (element.isConnected) {
      queueMicrotask(() => {
        if (disposed) return;
        runMountCallback(callback, "onMount", element);
      });
      return;
    }

    queueMicrotask(() => {
      if (disposed) return;
      if (element.isConnected) {
        runMountCallback(callback, "onMount", element);
        return;
      }
      const unregister = registerMountWatcher(element, () => {
        if (disposed) return;
        runMountCallback(callback, "onMount", element);
      });
      // Ensure watcher is removed on dispose
      registerDisposer(element, unregister);
    });
  } else {
    // No element specified — just defer to next microtask (after render)
    queueMicrotask(() => {
      safeCall(callback, "onMount");
    });
  }
}

/**
 * Runs a callback when the given element is removed from the DOM.
 * Uses a shared MutationObserver to watch for disconnection, plus
 * `registerDisposer` so explicit dispose() paths also trigger the callback.
 *
 * @param callback Function to run on unmount
 * @param element The element to watch for removal
 */
export function onUnmount(callback: CleanupFn, element: HTMLElement): void {
  if (typeof document === "undefined") return;

  let fired = false;
  const fireOnce = () => {
    if (fired) return;
    fired = true;
    safeCall(callback, "onUnmount");
  };

  // Primary path: registerDisposer handles dispose()/when()/match()/each().
  registerDisposer(element, fireOnce);

  // Fallback: shared MutationObserver catches manual .remove() calls.
  const startWatching = () => {
    if (fired) return;
    const unregister = registerUnmountWatcher(element, fireOnce);
    registerDisposer(element, unregister);
  };

  if (element.isConnected) {
    startWatching();
  } else {
    // Wait until connected before starting disconnect-watch
    onMount(() => {
      startWatching();
      return undefined;
    }, element);
  }
}

/**
 * Register a cleanup callback that runs when the given element is disposed.
 * Integrates with `when()`, `match()`, and `each()` which call `dispose()`
 * on removed nodes, triggering all registered cleanup functions.
 *
 * @param callback Cleanup function (close sockets, clear intervals, etc.)
 * @param element The component's root node to attach cleanup to
 *
 * @example
 * ```ts
 * function RealtimeBar(siteId: string) {
 *   const ws = new WebSocket(`/ws/sites/${siteId}/realtime`);
 *   const root = div("Realtime data...");
 *   onCleanup(() => ws.close(), root);
 *   return root;
 * }
 * ```
 */
export function onCleanup(callback: CleanupFn, element: Node): void {
  registerDisposer(element, callback);
}
