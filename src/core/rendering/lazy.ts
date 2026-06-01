import { devWarn } from "../dev";
import { dispose, registerDisposer } from "./dispose";
import { div, span } from "./html";

// Marker used by ErrorBoundary to detect a pending error stored on a node
// that was never mounted in time to dispatch via CustomEvent bubbling.
const PENDING_ERROR = "__sibuPendingError";

function dispatchPropagate(node: Element, error: Error): void {
  const fire = () => {
    try {
      if (!node.parentNode) return false;
      node.dispatchEvent(new CustomEvent("sibu:error-propagate", { bubbles: true, detail: { error } }));
      return true;
    } catch {
      return false;
    }
  };
  // Synchronous attempt for the common already-mounted case.
  if (node.parentNode && fire()) return;
  // Defer one microtask in case a fast rejection beat the mount.
  queueMicrotask(() => {
    if (fire()) return;
    // Last-resort: stash the error on the node so a delayed mount can
    // re-dispatch it. ErrorBoundary scans for this on its own connect.
    (node as unknown as Record<string, unknown>)[PENDING_ERROR] = error;
  });
}

export function takePendingError(node: Element): Error | undefined {
  const rec = node as unknown as Record<string, unknown>;
  const err = rec[PENDING_ERROR];
  if (err instanceof Error) {
    delete rec[PENDING_ERROR];
    return err;
  }
  return undefined;
}

type Component = () => HTMLElement;
type LazyImport = () => Promise<{ default: Component }>;

/**
 * lazy() enables code-splitting by deferring the import of a component
 * until it is first rendered. Returns a wrapper component that shows a
 * loading state while the import resolves.
 *
 * @example
 * ```ts
 * const LazyDashboard = lazy(() => import("./Dashboard"));
 *
 * // Use inside Suspense for custom loading UI
 * Suspense({
 *   nodes: () => LazyDashboard(),
 *   fallback: () => div("Loading dashboard..."),
 * });
 *
 * // Or use standalone — shows default "Loading..." text
 * LazyDashboard();
 * ```
 *
 * @param importFn Dynamic import function returning `{ default: Component }`
 * @returns A component function that lazy-loads on first call
 */
export function lazy(importFn: LazyImport): Component {
  let cached: Component | null = null;

  return function LazyComponent(): HTMLElement {
    // If already loaded, render immediately
    if (cached) {
      return cached();
    }

    const container = div({ class: "sibu-lazy" }) as HTMLElement;
    let disposed = false;

    importFn()
      .then((mod) => {
        if (disposed) return;
        cached = mod.default;
        const rendered = cached();
        container.replaceChildren(rendered);
      })
      .catch((err) => {
        if (disposed) return;
        const errorObj = err instanceof Error ? err : new Error(String(err));
        devWarn(`[SibuJS] lazy() failed to load component: ${errorObj.message}`);
        container.replaceChildren(div({ class: "sibu-lazy-error" }, `Failed to load component: ${errorObj.message}`));
        dispatchPropagate(container, errorObj);
      });

    // Show loading placeholder initially
    container.appendChild(span("sibu-lazy-loading", "Loading...") as Node);

    // Guard against stale loads if container is disposed before import resolves.
    // Previously this monkey-patched container.remove — now we hook into
    // the standard disposer chain, which covers when/match/each/dispose paths.
    registerDisposer(container, () => {
      disposed = true;
    });

    return container;
  };
}

/**
 * Suspense provides a fallback UI while lazy or async nodes are loading.
 *
 * @example
 * ```ts
 * Suspense({
 *   nodes: () => LazyChart(),
 *   fallback: () => div("Loading chart..."),
 * });
 * ```
 *
 * @param props.nodes Function that returns the async/lazy component
 * @param props.fallback Function that returns the loading UI
 * @returns An HTMLElement that swaps from fallback to content when ready
 */
export interface SuspenseProps {
  nodes: () => HTMLElement;
  fallback: () => HTMLElement;
}

export function Suspense({ nodes, fallback }: SuspenseProps): HTMLElement {
  const container = div({ class: "sibu-suspense" }) as HTMLElement;

  const fallbackEl = fallback();
  container.appendChild(fallbackEl);

  let suspenseDisposed = false;
  let observer: MutationObserver | null = null;
  // The child is created in a microtask and only attached to `container` once
  // loaded. If Suspense is disposed mid-load, the child is an orphan that the
  // container's dispose-walk never reaches, so its teardown (e.g. lazy()'s
  // load guard) would never run — a leak. Track it and dispose it explicitly.
  let childEl: HTMLElement | null = null;

  registerDisposer(container, () => {
    suspenseDisposed = true;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (childEl && !container.contains(childEl)) dispose(childEl);
  });

  queueMicrotask(() => {
    if (suspenseDisposed) return;
    try {
      const el = nodes();
      childEl = el;

      if (el.classList.contains("sibu-lazy")) {
        // Already loaded synchronously — swap and skip the observer entirely.
        if (!el.querySelector(".sibu-lazy-loading")) {
          container.replaceChildren(el);
          return;
        }
        observer = new MutationObserver(() => {
          if (suspenseDisposed) return;
          const loading = el.querySelector(".sibu-lazy-loading");
          if (!loading) {
            observer?.disconnect();
            observer = null;
            container.replaceChildren(el);
          }
        });
        observer.observe(el, { childList: true, subtree: true });
      } else {
        container.replaceChildren(el);
      }
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      devWarn(`[SibuJS] Suspense nodes() threw: ${errorObj.message}`);
      dispatchPropagate(container, errorObj);
    }
  });

  return container;
}
