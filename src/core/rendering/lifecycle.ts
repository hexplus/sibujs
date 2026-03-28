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
 *   return div({ nodes: "Hello" });
 * }
 * ```
 */

import { devWarn } from "../dev";
import { registerDisposer } from "./dispose";

type CleanupFn = () => void;

/** Safely invoke a lifecycle callback, catching and logging errors in dev mode. */
function safeCall(cb: () => unknown, hookName: string): void {
  try {
    cb();
  } catch (err) {
    devWarn(`${hookName}: callback threw: ${err instanceof Error ? err.message : String(err)}`);
  }
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
    // If element is already connected, run immediately (deferred)
    if (element.isConnected) {
      queueMicrotask(() => {
        safeCall(callback, "onMount");
      });
      return;
    }

    // Otherwise, use MutationObserver to detect when element enters the DOM
    const observer = new MutationObserver(() => {
      if (element.isConnected) {
        observer.disconnect();
        safeCall(callback, "onMount");
      }
    });

    // Observe the document body for childList changes (subtree)
    queueMicrotask(() => {
      if (element.isConnected) {
        safeCall(callback, "onMount");
      } else {
        observer.observe(document.body, { childList: true, subtree: true });
      }
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
 * Uses MutationObserver to watch for disconnection.
 *
 * @param callback Function to run on unmount
 * @param element The element to watch for removal
 */
export function onUnmount(callback: CleanupFn, element: HTMLElement): void {
  // Wait until element is in the DOM before observing removal
  const startObserving = () => {
    const observer = new MutationObserver(() => {
      if (!element.isConnected) {
        observer.disconnect();
        safeCall(callback, "onUnmount");
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (element.isConnected) {
    startObserving();
  } else {
    // Wait for it to be mounted first, then observe for removal
    onMount(() => {
      startObserving();
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
 *   const root = div({ nodes: "Realtime data..." });
 *   onCleanup(() => ws.close(), root);
 *   return root;
 * }
 * ```
 */
export function onCleanup(callback: CleanupFn, element: Node): void {
  registerDisposer(element, callback);
}
