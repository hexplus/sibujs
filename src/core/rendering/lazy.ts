import { bindOwnerScope, captureFrozen, type HeldCheck, holdSubtree, structuralBinding } from "../../reactivity/track";
import type { StructuralBinding } from "../../reactivity/track-core";
import { reportError } from "../errors";
import { trackPending } from "../ssr-context";
import { captureScope, inAdoptScope, inScope } from "./adoptScope";
import { dispose, registerDisposer, replaceChildrenSafely } from "./dispose";
import { div, span } from "./html";
import { isHydrating } from "./hydrationHooks";
import { beginLoading } from "./range";
import { currentBoundary, openBoundary } from "./streamBoundary";
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
const NOOP = (): void => {};

/** The wait a renderer has in progress for its lifecycle to resume; see {@link whenActive}. */
interface Waiting {
  cancel: () => void;
}

/**
 * Run `commit` once the lifecycle `held` is active: now, or after it resumes.
 * Every notification is checked again when it arrives — the lifecycle may
 * have paused again in between, and then the wait goes on — so a
 * notification alone is never permission to run. `node` (built, not yet
 * committed) is held meanwhile (`holdSubtree`): its bindings do not react to
 * state while the lifecycle is paused, and catch up once, when it is
 * released just before `commit`. If the lifecycle ends first, or
 * `slot.cancel()` is called (the renderer was disposed), `discard` runs
 * instead — before the hold is released, so what the node skipped is
 * dropped, never replayed. `slot.cancel` is the wait in progress, if any.
 */
function whenActive(slot: Waiting, held: HeldCheck, node: Node | null, discard: () => void, commit: () => void): void {
  let over = false;
  let unhold: (() => void) | null = null;
  let drop = NOOP;
  const cancel = (): void => end(false);
  const end = (active: boolean): void => {
    if (over) return;
    over = true;
    if (slot.cancel === cancel) slot.cancel = NOOP;
    drop();
    drop = NOOP;
    const release = unhold;
    unhold = null;
    if (active) {
      release?.();
      commit();
      return;
    }
    try {
      discard();
    } finally {
      release?.();
    }
  };
  const check = (): void => {
    if (over) return;
    const state = held.state();
    if (state !== 1) {
      end(state === 0);
      return;
    }
    if (node !== null && unhold === null) unhold = holdSubtree(node);
    slot.cancel = cancel;
    drop = held.wait(check, check);
  };
  check();
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
 * The loaded component belongs to the lifecycle the placeholder was rendered
 * in (a `when()` branch, a route instance, a `Suspense`'s content): while that
 * lifecycle is paused — a branch playing its leave, a
 * `KeepAliveRoute({ suspendInactive: true })` page that is hidden — the module
 * is kept and nothing is built or committed until it resumes; if it ends,
 * nothing is. The component is built under its own lifecycle, nested in that
 * one: a `lifecycleScope()` it captures pauses with the page, and ends when
 * the container is disposed. The loaded module is cached either way.
 *
 * A synchronous throw from `importFn` propagates to the caller; nothing is
 * left registered for the container that was never returned.
 *
 * @param importFn Dynamic import function returning `{ default: Component }`
 * @returns A component function that lazy-loads on first call
 */
export function lazy<R extends Node = HTMLElement>(
  importFn: () => Promise<{ default: Component<void, R> }>,
): Component<void, R | HTMLDivElement> {
  let cached: Component<void, R> | null = null;

  return function LazyComponent(): R | HTMLDivElement {
    // If already loaded, render immediately — except when adoption markers are
    // in play, where the shape must not depend on whether this process (or
    // this page) has loaded the chunk before: always the container.
    if (cached && !inAdoptScope()) {
      return cached();
    }

    const container = div({ class: "sibu-lazy" });
    const scope = captureScope();
    // Created inside a streaming Suspense boundary: the chunk's render belongs to it.
    const boundary = currentBoundary();
    // A placeholder, built outside any adoption scope: it takes no id, so the
    // ids that follow do not depend on whether the chunk is already loaded.
    const loading = inScope(null, () => span("sibu-lazy-loading", "Loading..."));
    if (cached) {
      const loaded = cached;
      replaceChildrenSafely(container, inScope(scope, () => loaded()) as Node);
      return container;
    }

    // The lifecycle the placeholder renders in, and its owner scope (a route
    // instance's route): the component is built and committed in them, only
    // while that lifecycle is active.
    const held = captureFrozen();
    const inOwner = bindOwnerScope((fn: () => void) => fn());
    // Pending content until the chunk's component (or the error) is in the
    // container, for an enter that waits for it (`waitForContent`).
    const ready = beginLoading(container);
    let disposed = false;
    // The loaded component's own lifecycle, once committed.
    let owner: StructuralBinding | null = null;
    const waiting: Waiting = { cancel: NOOP };

    // Installed BEFORE any user code runs (`importFn` below): from here on,
    // disposing the container releases the readiness registration, a wait
    // for the lifecycle (and what it holds) and the component's lifecycle.
    // Guards stale loads too: covers when/match/each/dispose paths.
    registerDisposer(container, () => {
      disposed = true;
      waiting.cancel();
      ready.cancel();
      const own = owner;
      owner = null;
      own?.stop();
    });

    // Show loading placeholder initially — unless this is an adopted container
    // still showing the server's loaded content until the chunk arrives.
    if (!(isHydrating() && container.firstChild)) container.appendChild(loading);

    const fail = (err: unknown): void => {
      if (disposed) return;
      const errorObj = err instanceof Error ? err : new Error(String(err));
      replaceChildrenSafely(
        container,
        div({ class: "sibu-lazy-error" }, `Failed to load component: ${errorObj.message}`),
      );
      ready.done();
      dispatchPropagate(container, errorObj);
    };

    const build = (component: Component<void, R>): void => {
      if (disposed) return;
      const own = held.run(() => structuralBinding(NOOP));
      let rendered: R;
      try {
        const render = () => own.run(() => inScope(scope, () => component()));
        rendered = boundary ? boundary.enter(render) : render();
      } catch (err) {
        own.stop();
        fail(err);
        return;
      }
      // The component is user code: it may have disposed the container, or
      // paused or ended the lifecycle. Re-checked right before the commit.
      if (disposed) {
        own.stop();
        dispose(rendered);
        return;
      }
      whenActive(
        waiting,
        held,
        rendered,
        () => {
          own.stop();
          dispose(rendered);
          ready.cancel();
        },
        () => {
          owner = own;
          replaceChildrenSafely(container, rendered);
          ready.done();
        },
      );
    };

    let imported: Promise<{ default: Component<void, R> }>;
    try {
      imported = importFn();
    } catch (err) {
      // Never returned: release what was set up for it, then propagate.
      dispose(container);
      throw err;
    }
    // A server render waits for the chunk (and, through the settle loop, for
    // whatever the loaded component starts).
    trackPending(imported, "lazy").then(
      (mod: { default: Component<void, R> }) => {
        if (disposed) return;
        // Cached whatever the lifecycle does: another instance may use it.
        cached = mod.default;
        const component = cached;
        whenActive(
          waiting,
          held,
          null,
          () => ready.cancel(),
          () => inOwner(() => build(component)),
        );
      },
      (err: unknown) => {
        if (disposed) return;
        whenActive(
          waiting,
          held,
          null,
          () => ready.cancel(),
          () => inOwner(() => fail(err)),
        );
      },
    );

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
  const scope = captureScope();
  // The lifecycle the boundary renders in, and its owner scope: the content
  // is built (in a microtask) and committed in them, only while that
  // lifecycle is active (see `lazy`).
  const held = captureFrozen();
  const inOwner = bindOwnerScope((fn: () => void) => fn());
  // A streaming server render streams this boundary's content on its own.
  const boundary = openBoundary(container);
  // Pending content until the content is committed (or fails), for an enter
  // that waits for it (`waitForContent`).
  const ready = beginLoading(container);
  let suspenseDisposed = false;
  let observer: MutationObserver | null = null;
  // The child is created in a microtask and only attached to `container` once
  // loaded. If Suspense is disposed mid-load, the child is an orphan that the
  // container's dispose-walk never reaches, so its teardown (e.g. lazy()'s
  // load guard) would never run — a leak. Track it and dispose it explicitly.
  let childEl: Element | null = null;
  // The content's lifecycle, nested in the boundary's: `nodes()` runs as it,
  // so what it creates — a `lazy()` placeholder, a `lifecycleScope()` —
  // pauses with the boundary's lifecycle and ends with the boundary.
  let contentOwner: StructuralBinding | null = null;
  const waiting: Waiting = { cancel: NOOP };

  // Installed BEFORE any user code runs (`fallback` below).
  registerDisposer(container, () => {
    suspenseDisposed = true;
    waiting.cancel();
    ready.cancel();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (childEl && !container.contains(childEl)) dispose(childEl);
    const own = contentOwner;
    contentOwner = null;
    own?.stop();
  });

  // Outside any adoption scope, like lazy()'s placeholder: a fallback the
  // server replaced must not shift the ids of what follows.
  let fallbackEl: Node;
  try {
    fallbackEl = inScope(null, fallback);
  } catch (err) {
    // Never returned: release what was set up for it (a streaming render
    // must not wait for this boundary), then propagate.
    boundary?.done();
    dispose(container);
    throw err;
  }
  // An adopted boundary keeps the server's content on screen instead of
  // flashing the fallback while its content builds.
  if (isHydrating() && container.firstChild) dispose(fallbackEl);
  else container.appendChild(fallbackEl);

  /** Swap the fallback for `el` once the lifecycle is active; dropped if it ends. */
  const commit = (el: Element): void => {
    whenActive(
      waiting,
      held,
      el,
      () => {
        if (childEl === el) childEl = null;
        dispose(el);
        ready.cancel();
      },
      () => {
        // Committing swaps the fallback out for `el`. The fallback is
        // user-authored and may hold reactive bindings, lifecycle hooks, and
        // listeners, so it must be disposed as it is detached — a bare
        // replaceChildren() would leave it re-rendering off-screen forever.
        // `replaceChildrenSafely` never disposes the incoming `el`.
        replaceChildrenSafely(container, el);
        boundary?.done();
        ready.done();
      },
    );
  };

  const renderContent = (): void => {
    if (suspenseDisposed) return;
    const own = held.run(() => structuralBinding(NOOP));
    contentOwner = own;
    let el: Element;
    try {
      const build = () => own.run(() => inScope(scope, nodes));
      el = boundary ? boundary.enter(build) : build();
    } catch (err) {
      contentOwner = null;
      own.stop();
      const errorObj = err instanceof Error ? err : new Error(String(err));
      // No content and no error view: the readiness is released, nothing
      // joins an enter for it. The fallback stays; the error goes to the
      // nearest boundary.
      ready.cancel();
      dispatchPropagate(container, errorObj);
      return;
    }
    childEl = el;
    // `nodes()` is user code: it may have disposed the boundary.
    if (suspenseDisposed) {
      childEl = null;
      dispose(el);
      return;
    }
    if (el.classList.contains("sibu-lazy")) {
      // Already loaded synchronously — swap and skip the observer entirely.
      if (!el.querySelector(".sibu-lazy-loading")) {
        commit(el);
        return;
      }
      observer = new MutationObserver(() => {
        if (suspenseDisposed) return;
        const loading = el.querySelector(".sibu-lazy-loading");
        if (!loading) {
          observer?.disconnect();
          observer = null;
          commit(el);
        }
      });
      observer.observe(el, { childList: true, subtree: true });
    } else {
      commit(el);
    }
  };
  // The content is built in a microtask, in the owner scope Suspense was
  // created in — once the lifecycle it was created in is active.
  queueMicrotask(() => {
    whenActive(
      waiting,
      held,
      null,
      () => ready.cancel(),
      () => inOwner(renderContent),
    );
  });

  return container;
}
