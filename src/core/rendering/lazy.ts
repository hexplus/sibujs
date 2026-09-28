import { bindOwnerScope } from "../../reactivity/track";
import { reportError } from "../errors";
import { dispose, registerDisposer, replaceChildrenSafely } from "./dispose";
import { div, span } from "./html";
import type { Component } from "./types";

// Marker used by ErrorBoundary to detect a pending error stored on a node
// that was never mounted in time to be offered to a boundary.
const PENDING_ERROR = "__sibuPendingError";

/**
 * Surface a lazy-loading failure.
 *
 * Once the node is attached this goes through the CENTRAL pipeline, so an
 * enclosing `ErrorBoundary` gets first refusal and — crucially — an error no
 * boundary claims still reaches the runtime handler or the console instead of
 * disappearing because a dispatch happened.
 *
 * The stash is the one deliberate exception to "always report immediately": a
 * lazy import can reject BEFORE its container is linked to any parent, and
 * boundary lookup walks the parentNode chain. Reporting straight to the console
 * at that point would defeat a boundary that is about to mount above it, so the
 * error is parked on the node and `ErrorBoundary` collects it during its own
 * mount scan (see `takePendingError`).
 *
 * Known limitation: a container that is never attached keeps its stashed error
 * unreported. That subtree was never rendered, so there is no boundary and no
 * DOM position to attribute it to.
 */
function dispatchPropagate(node: Element, error: Error): void {
  const report = (): boolean => {
    if (!node.parentNode) return false;
    reportError(error, { phase: "render", name: "lazy", node });
    return true;
  };
  // Synchronous attempt for the common already-mounted case.
  if (report()) return;
  // Defer one microtask in case a fast rejection beat the mount.
  queueMicrotask(() => {
    if (report()) return;
    (node as unknown as Record<string, unknown>)[PENDING_ERROR] = error;
  });
}

/**
 * Read and CLEAR an error stashed on a node by an async boundary.
 *
 * Consuming is the point: an error handed to one boundary must not also reach
 * an outer one, so this is deliberately not a plain getter.
 *
 * @param node Element the error was stashed on.
 * @returns The pending error, or `undefined` when there is none.
 */
export function takePendingError(node: Element): Error | undefined {
  const rec = node as unknown as Record<string, unknown>;
  const err = rec[PENDING_ERROR];
  if (err instanceof Error) {
    delete rec[PENDING_ERROR];
    return err;
  }
  return undefined;
}

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
 * The returned component renders either the loading container (a `div`) or,
 * once loaded, the component's own root — its return type is the union, so an
 * SVG component stays usable without a cast.
 *
 * @param importFn Dynamic import function returning `{ default: Component }`
 * @returns A component function that lazy-loads on first call
 */
export function lazy<R extends Node = HTMLElement>(
  importFn: () => Promise<{ default: Component<void, R> }>,
): Component<void, R | HTMLDivElement> {
  let cached: Component<void, R> | null = null;

  return function LazyComponent(): R | HTMLDivElement {
    // If already loaded, render immediately
    if (cached) {
      return cached();
    }

    const container = div({ class: "sibu-lazy" });
    let disposed = false;

    importFn()
      .then(
        // The component renders after the import resolves, in the owner scope
        // of whoever rendered the placeholder.
        bindOwnerScope((mod: { default: Component<void, R> }) => {
          if (disposed) return;
          cached = mod.default;
          const rendered = cached();
          replaceChildrenSafely(container, rendered);
        }),
      )
      .catch((err) => {
        if (disposed) return;
        const errorObj = err instanceof Error ? err : new Error(String(err));
        replaceChildrenSafely(
          container,
          div({ class: "sibu-lazy-error" }, `Failed to load component: ${errorObj.message}`),
        );
        dispatchPropagate(container, errorObj);
      });

    // Show loading placeholder initially
    container.appendChild(span("sibu-lazy-loading", "Loading..."));

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
 * @returns A container element that swaps from fallback to content when ready
 */
export interface SuspenseProps {
  /** The content's root must be an element (HTML or SVG): its loading state is read from it. */
  nodes: () => Element;
  /** Any node, including a text node or fragment. */
  fallback: () => Node;
}

/**
 * Render `fallback` until the async `nodes` factory resolves, then swap it for
 * the resolved content.
 *
 * @param props `nodes` is the async content factory; `fallback` builds the
 * placeholder shown while it is pending.
 * @returns The live container element, already holding the fallback.
 *
 * TRAP — the swap REPLACES the container's children, so focus and selection in
 * the fallback are discarded. That is usually harmless (a spinner rarely holds
 * focus) but matters for a skeleton form; see the note on `when`.
 */
export function Suspense({ nodes, fallback }: SuspenseProps): HTMLDivElement {
  const container = div({ class: "sibu-suspense" });

  const fallbackEl = fallback();
  container.appendChild(fallbackEl);

  let suspenseDisposed = false;
  let observer: MutationObserver | null = null;
  // The child is created in a microtask and only attached to `container` once
  // loaded. If Suspense is disposed mid-load, the child is an orphan that the
  // container's dispose-walk never reaches, so its teardown (e.g. lazy()'s
  // load guard) would never run — a leak. Track it and dispose it explicitly.
  let childEl: Element | null = null;

  registerDisposer(container, () => {
    suspenseDisposed = true;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (childEl && !container.contains(childEl)) dispose(childEl);
  });

  const renderContent = bindOwnerScope(() => {
    if (suspenseDisposed) return;
    try {
      const el = nodes();
      childEl = el;

      // Committing swaps the fallback out for `el`. The fallback is
      // user-authored and may hold reactive bindings, lifecycle hooks, and
      // listeners, so it must be disposed as it is detached — a bare
      // replaceChildren() would leave it re-rendering off-screen forever.
      // `replaceChildrenSafely` never disposes the incoming `el`.
      if (el.classList.contains("sibu-lazy")) {
        // Already loaded synchronously — swap and skip the observer entirely.
        if (!el.querySelector(".sibu-lazy-loading")) {
          replaceChildrenSafely(container, el);
          return;
        }
        observer = new MutationObserver(() => {
          if (suspenseDisposed) return;
          const loading = el.querySelector(".sibu-lazy-loading");
          if (!loading) {
            observer?.disconnect();
            observer = null;
            replaceChildrenSafely(container, el);
          }
        });
        observer.observe(el, { childList: true, subtree: true });
      } else {
        replaceChildrenSafely(container, el);
      }
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      dispatchPropagate(container, errorObj);
    }
  });
  // The content is built in a microtask, in the owner scope Suspense was
  // created in.
  queueMicrotask(renderContent);

  return container;
}
