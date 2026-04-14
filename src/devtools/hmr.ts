/**
 * Hot Module Replacement utilities for SibuJS.
 * Preserves component state during development reloads.
 *
 * During development the HMR runtime keeps a global store of component state
 * keyed by a developer-supplied ID.  When a module is hot-reloaded the new
 * component implementation can re-use the preserved state so that the user
 * does not lose context (form values, scroll position, etc.).
 *
 * The utilities integrate with bundlers that expose a `module.hot` or
 * `import.meta.hot` API (Webpack, Vite, Parcel, etc.).
 */

import { dispose as disposeNode } from "../core/rendering/dispose";
import { signal } from "../core/signals/signal";

// ---------------------------------------------------------------------------
// Internal HMR state store
// ---------------------------------------------------------------------------

/** Maximum number of entries in the HMR state store before FIFO eviction kicks in. */
const HMR_STORE_MAX_SIZE = 200;

/** Global state store that survives across module reloads */
const hmrStateStore = new Map<string, unknown>();

/**
 * Insert / update an entry in the HMR state store, enforcing a FIFO cap.
 * When the cap is exceeded the oldest entry is dropped and a one-time warning
 * is emitted so the developer can notice leaks.
 */
let hmrStoreOverflowWarned = false;
function hmrStoreSet(id: string, value: unknown): void {
  // Re-insert to keep insertion-order fresh (Map preserves insertion order)
  if (hmrStateStore.has(id)) hmrStateStore.delete(id);
  hmrStateStore.set(id, value);
  if (hmrStateStore.size > HMR_STORE_MAX_SIZE) {
    const oldestKey = hmrStateStore.keys().next().value;
    if (oldestKey !== undefined) hmrStateStore.delete(oldestKey);
    if (!hmrStoreOverflowWarned) {
      hmrStoreOverflowWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[sibujs/hmr] HMR state store exceeded ${HMR_STORE_MAX_SIZE} entries — oldest entries are being evicted. ` +
          `Call clearHMRModule(id) from your module's accept/dispose handlers to avoid this.`,
      );
    }
  }
}

/**
 * Remove a single HMR module entry (state + registry) by id.
 * Call this from `import.meta.hot.accept()` / `module.hot.dispose()` handlers
 * when the module is being fully replaced or torn down.
 */
export function clearHMRModule(id: string): void {
  hmrStateStore.delete(id);
  hmrRegistry.delete(id);
  hmrRegistry.delete(`boundary:${id}`);
}

/** Registry of active HMR component registrations */
const hmrRegistry = new Map<
  string,
  {
    component: () => HTMLElement;
    container?: HTMLElement;
    currentElement?: HTMLElement;
    disposeCallbacks: Array<() => void>;
  }
>();

// ---------------------------------------------------------------------------
// hmrState
// ---------------------------------------------------------------------------

/**
 * Create an HMR-aware state that persists across module reloads.
 * During development, state is stored in a global map keyed by a unique `id`.
 * On the first load the `initial` value is used; on subsequent hot reloads
 * the previously stored value is restored.
 *
 * @param id       Unique identifier for this state (should be stable across reloads)
 * @param initial  Initial value used on the very first load
 * @returns A `[getter, setter]` tuple compatible with `signal`
 *
 * @example
 * ```ts
 * const [count, setCount] = hmrState("MyCounter.count", 0);
 * // After a hot reload, `count()` will still return the last known value.
 * ```
 */
export function hmrState<T>(id: string, initial: T): [() => T, (value: T | ((prev: T) => T)) => void] {
  // Restore from the HMR store if a previous value exists
  const restored = hmrStateStore.has(id) ? (hmrStateStore.get(id) as T) : initial;

  const [get, set] = signal<T>(restored);

  function hmrSet(next: T | ((prev: T) => T)): void {
    set(next);
    // Persist the latest value so it survives the next hot reload
    hmrStoreSet(id, get());
  }

  // Also persist the initial / restored value immediately
  hmrStoreSet(id, restored);

  return [get, hmrSet];
}

// ---------------------------------------------------------------------------
// registerHMR
// ---------------------------------------------------------------------------

/**
 * Register a component for HMR updates.
 * When the module is hot-reloaded the component is re-rendered with preserved
 * state by swapping out the old DOM element for the new one produced by the
 * updated component function.
 *
 * @param id          Stable identifier for the component
 * @param component   Factory function that returns the component's root element
 * @param container   Optional container element – if provided the initial element
 *                    is automatically appended to it
 * @returns An object with `update` (swap implementation) and `dispose` (clean up)
 *
 * @example
 * ```ts
 * const hmr = registerHMR("MyWidget", () => MyWidget());
 *
 * // On hot update:
 * hmr.update(() => MyWidgetV2());
 *
 * // On full teardown:
 * hmr.dispose();
 * ```
 */
export function registerHMR(
  id: string,
  component: () => HTMLElement,
  container?: HTMLElement,
): {
  /** Update the component implementation (called on hot reload) */
  update: (newComponent: () => HTMLElement) => void;
  /** Dispose the HMR registration */
  dispose: () => void;
} {
  // Build the initial element
  const currentElement = component();

  const entry = {
    component,
    container,
    currentElement,
    disposeCallbacks: [] as Array<() => void>,
  };

  hmrRegistry.set(id, entry);

  // If a container was provided, append the initial element
  if (container) {
    container.appendChild(currentElement);
  }

  function update(newComponent: () => HTMLElement): void {
    const reg = hmrRegistry.get(id);
    if (!reg) return;

    // Run any registered dispose callbacks before swapping
    for (const cb of reg.disposeCallbacks) {
      try {
        cb();
      } catch {
        // swallow errors during dispose
      }
    }
    reg.disposeCallbacks.length = 0;

    const newElement = newComponent();
    const oldElement = reg.currentElement;

    if (oldElement?.parentNode) {
      oldElement.parentNode.replaceChild(newElement, oldElement);
    }
    // Run reactive disposers on the OLD subtree after detaching, so effects
    // and listeners inside the previous version don't leak across reloads.
    if (oldElement) disposeNode(oldElement);

    reg.component = newComponent;
    reg.currentElement = newElement;
  }

  function dispose(): void {
    const reg = hmrRegistry.get(id);
    if (!reg) return;

    for (const cb of reg.disposeCallbacks) {
      try {
        cb();
      } catch {
        // swallow
      }
    }

    if (reg.currentElement) {
      const el = reg.currentElement;
      if (el.parentNode) el.parentNode.removeChild(el);
      disposeNode(el);
    }

    hmrRegistry.delete(id);
  }

  return { update, dispose };
}

// ---------------------------------------------------------------------------
// createHMRBoundary
// ---------------------------------------------------------------------------

/**
 * Create an HMR boundary.
 * Components within the boundary are hot-reloaded independently.  The boundary
 * keeps track of accept/dispose callbacks and can wrap a component factory so
 * that hot updates are handled transparently.
 *
 * @param id  Stable boundary identifier
 * @returns Boundary helpers: `wrap`, `accept`, `dispose`
 *
 * @example
 * ```ts
 * const boundary = createHMRBoundary("settings-panel");
 *
 * const el = boundary.wrap(() => SettingsPanel());
 * document.body.appendChild(el);
 *
 * boundary.accept(() => console.log("Hot update accepted"));
 * boundary.dispose(() => console.log("Cleaning up old version"));
 * ```
 */
export function createHMRBoundary(id: string): {
  /** Wrap a component for HMR support */
  wrap: (component: () => HTMLElement) => HTMLElement;
  /** Accept a hot update */
  accept: (callback?: () => void) => void;
  /** Dispose callback */
  dispose: (callback: () => void) => void;
} {
  let currentElement: HTMLElement | null = null;
  let currentComponent: (() => HTMLElement) | null = null;
  const acceptCallbacks: Array<() => void> = [];
  const disposeCallbacks: Array<() => void> = [];

  /**
   * Wrap a component factory so that it can be hot-swapped later.
   * A wrapper `<div data-hmr-boundary="<id>">` is inserted around the
   * component to act as a stable mount point.
   */
  function wrap(component: () => HTMLElement): HTMLElement {
    currentComponent = component;

    // Create a boundary wrapper that stays in the DOM across reloads
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-hmr-boundary", id);

    const element = component();
    currentElement = element;
    wrapper.appendChild(element);

    // Store reference in the registry so registerHMR can find it
    hmrRegistry.set(`boundary:${id}`, {
      component,
      container: wrapper,
      currentElement: element,
      disposeCallbacks,
    });

    return wrapper;
  }

  /**
   * Accept a hot update.  When the boundary receives a new component
   * implementation the accept callbacks are invoked and the old element
   * is replaced.
   */
  function accept(callback?: () => void): void {
    if (callback) {
      acceptCallbacks.push(callback);
    }

    // If there is a bundler HMR API available, hook into it
    if (typeof (globalThis as unknown as Record<string, unknown>).__SIBU_HMR_ACCEPT__ === "function") {
      ((globalThis as unknown as Record<string, unknown>).__SIBU_HMR_ACCEPT__ as (id: string, cb: () => void) => void)(
        id,
        () => {
          // Run dispose callbacks
          for (const cb of disposeCallbacks) {
            try {
              cb();
            } catch {
              /* swallow */
            }
          }
          disposeCallbacks.length = 0;

          if (currentComponent && currentElement) {
            const oldEl = currentElement;
            const parent = oldEl.parentNode;
            if (parent) {
              const newElement = currentComponent();
              parent.replaceChild(newElement, oldEl);
              // Tear down reactive bindings inside the previous version so
              // each hot reload doesn't accumulate effects/listeners.
              disposeNode(oldEl);
              currentElement = newElement;
            }
          }

          // Run accept callbacks
          for (const cb of acceptCallbacks) {
            try {
              cb();
            } catch {
              /* swallow */
            }
          }
        },
      );
    }
  }

  /**
   * Register a dispose callback that runs before the old component is
   * torn down during a hot update.
   */
  function disposeFn(callback: () => void): void {
    disposeCallbacks.push(callback);
  }

  return { wrap, accept, dispose: disposeFn };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Clear all HMR state (useful for a full page refresh or test teardown).
 */
export function clearHMRState(): void {
  hmrStateStore.clear();
  hmrRegistry.clear();
  hmrStoreOverflowWarned = false;
}

/**
 * Register HMR helpers under `__SIBU__.hmr` so devtools panels can reach them.
 * Call this explicitly from your app bootstrap when you want the exposure —
 * nothing is attached by default, matching initDevTools({ expose: true }).
 */
export function exposeHMR(): void {
  const g = globalThis as unknown as {
    __SIBU__?: { version: string; hmr?: unknown };
  };
  if (!g.__SIBU__) g.__SIBU__ = { version: "1.0.0" };
  g.__SIBU__.hmr = {
    hmrState,
    registerHMR,
    createHMRBoundary,
    clearHMRState,
    clearHMRModule,
    isHMRAvailable,
  };
}

/**
 * Check if HMR is available in the current environment.
 * Returns `true` when any of the common bundler HMR APIs are detected
 * (`module.hot` for Webpack, `import.meta.hot` for Vite, or the SibuJS
 * custom hook).
 */
export function isHMRAvailable(): boolean {
  const g = globalThis as unknown as Record<string, unknown>;

  // Webpack
  if ((g.module as Record<string, unknown> | undefined)?.hot) {
    return true;
  }

  // Vite / generic import.meta.hot — import.meta is not accessible at
  // runtime via globalThis, so we check for the SibuJS custom hook instead.
  if (typeof g.__SIBU_HMR_ACCEPT__ === "function") {
    return true;
  }

  // Parcel
  if ((g.module as Record<string, unknown> | undefined)?.hot) {
    return true;
  }

  return false;
}
