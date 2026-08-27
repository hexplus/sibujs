import { registerDisposer, replaceChildrenSafely } from "../core/rendering/dispose";
import { div, span } from "../core/rendering/html";
import { signal } from "../core/signals/signal";
import { globalSingleton } from "../utils/globalSingleton";

// ============================================================================
// MICRO-FRONTEND / MODULE FEDERATION
// ============================================================================

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface MicroAppConfig {
  /** Unique name for this micro-frontend instance */
  name: string;
  /** Optional host element to mount into. Defaults to a new div. */
  container?: HTMLElement;
  /** If true, use Shadow DOM for style isolation */
  shadow?: boolean;
}

export interface MicroApp {
  /** Mount a component into this micro-app container */
  mount(component: () => HTMLElement): void;
  /** Unmount the currently rendered component and clean up */
  unmount(): void;
  /** The outer host element */
  element: HTMLElement;
}

export interface SharedScope<T extends object> {
  /** Get the current value for a key */
  get<K extends keyof T>(key: K): T[K];
  /** Set a value for a key, notifying all subscribers */
  set<K extends keyof T>(key: K, value: T[K]): void;
  /** Subscribe to changes on a specific key. Returns an unsubscribe function. */
  subscribe<K extends keyof T>(key: K, callback: (value: T[K]) => void): () => void;
}

// --------------------------------------------------------------------------
// Module cache for loadRemoteModule
// --------------------------------------------------------------------------

// Shared across duplicate module copies so a double-loaded bundle dedups the
// in-flight import of the same remote URL instead of fetching it twice.
const moduleCache = globalSingleton(
  Symbol.for("sibujs.microfrontend.moduleCache.v1"),
  () => new Map<string, Promise<unknown>>(),
);

// --------------------------------------------------------------------------
// createMicroApp
// --------------------------------------------------------------------------

/**
 * Creates an isolated micro-frontend container.
 *
 * Each micro-app gets its own DOM boundary. When `shadow: true` is set the
 * component renders inside a Shadow DOM root so its styles are fully isolated
 * from the host page.
 *
 * @example
 * ```ts
 * const app = createMicroApp({ name: "widget", shadow: true });
 * document.body.appendChild(app.element);
 *
 * app.mount(() => div("Hello from micro-app!"));
 *
 * // Later, tear it down:
 * app.unmount();
 * ```
 */
export function createMicroApp(config: MicroAppConfig): MicroApp {
  const host = config.container ?? document.createElement("div");
  host.setAttribute("data-micro-app", config.name);

  let root: HTMLElement | ShadowRoot;
  if (config.shadow) {
    root = host.attachShadow({ mode: "open" });
  } else {
    root = host;
  }

  let mounted = false;

  function mount(component: () => HTMLElement): void {
    // Build the incoming tree BEFORE tearing the old one down, so a component
    // factory that throws leaves the previous mount intact rather than an
    // emptied container.
    const el = component();

    // Replace through the disposal-aware primitive. A bare `replaceChildren()`
    // detaches the outgoing tree without running SibuJS teardown, so every
    // effect, binding and listener inside it survived as an unreachable zombie
    // firing against detached DOM — one leaked component tree per remount.
    //
    // `replaceChildrenSafely` also detaches the INCOMING node first, so
    // re-mounting a node that is already inside the container keeps it alive
    // instead of disposing the very tree being re-installed.
    replaceChildrenSafely(root, el);
    mounted = true;
  }

  function unmount(): void {
    if (!mounted) return;
    replaceChildrenSafely(root);
    mounted = false;
  }

  return { mount, unmount, element: host };
}

// --------------------------------------------------------------------------
// loadRemoteModule
// --------------------------------------------------------------------------

/**
 * Dynamically load a remote ES module by URL.
 *
 * Modules are cached by URL so repeated calls with the same URL return the
 * same promise without issuing another network request.
 *
 * An origin policy is REQUIRED: importing a remote module is remote code
 * execution, so the call is refused unless you either restrict it with
 * `allowedOrigins` or opt out deliberately with `unsafelyAllowAnyOrigin`
 * (CWE-829).
 *
 * @example
 * ```ts
 * const charts = await loadRemoteModule("https://cdn.example.com/charts.js", {
 *   allowedOrigins: ["https://cdn.example.com"],
 * });
 * const el = charts.BarChart({ data: [1, 2, 3] });
 * ```
 */
export interface LoadRemoteModuleOptions {
  allowedOrigins?: string[];
  /** Required when allowedOrigins is empty. Forces a deliberate decision
   *  to import code from any URL — equivalent to remote eval (CWE-829). */
  unsafelyAllowAnyOrigin?: boolean;
}

export function loadRemoteModule(
  url: string,
  optionsOrAllowedOrigins: string[] | LoadRemoteModuleOptions = [],
): Promise<unknown> {
  const opts: LoadRemoteModuleOptions = Array.isArray(optionsOrAllowedOrigins)
    ? { allowedOrigins: optionsOrAllowedOrigins }
    : optionsOrAllowedOrigins;
  const allowedOrigins = opts.allowedOrigins ?? [];

  if (allowedOrigins.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(url, typeof location !== "undefined" ? location.href : undefined);
    } catch {
      return Promise.reject(new Error(`loadRemoteModule: invalid URL "${url}"`));
    }
    if (!allowedOrigins.includes(parsed.origin)) {
      return Promise.reject(new Error(`loadRemoteModule: origin "${parsed.origin}" is not in the allowlist`));
    }
  } else if (!opts.unsafelyAllowAnyOrigin) {
    return Promise.reject(
      new Error(
        `loadRemoteModule: refused to import "${url}" with no allowedOrigins. ` +
          "Pass { allowedOrigins: [...] } to restrict the origin, or " +
          "{ unsafelyAllowAnyOrigin: true } to opt in to unrestricted imports (CWE-829).",
      ),
    );
  }

  const cached = moduleCache.get(url);
  if (cached) return cached;

  const promise = import(/* @vite-ignore */ url);
  moduleCache.set(url, promise);

  // On failure, evict from cache so a retry can succeed
  promise.catch(() => {
    moduleCache.delete(url);
  });

  return promise;
}

// --------------------------------------------------------------------------
// defineRemoteComponent
// --------------------------------------------------------------------------

type Component = () => HTMLElement;
type RemoteLoader = () => Promise<{ default: Component }>;

/**
 * Register a remote component that loads on demand.
 *
 * Returns a component factory function. On first call it shows a loading
 * placeholder, fetches the remote module, then swaps in the real component.
 * Subsequent calls render instantly from the cached module.
 *
 * The load is owner-scoped: if the container is disposed before the module
 * arrives, the module is still cached (it is shared and expensive to fetch) but
 * the component is NOT instantiated and nothing is written into the dead
 * container.
 *
 * @example
 * ```ts
 * const RemoteHeader = defineRemoteComponent(
 *   "remote-header",
 *   () =>
 *     loadRemoteModule("https://cdn.example.com/header.js", {
 *       allowedOrigins: ["https://cdn.example.com"],
 *     })
 * );
 *
 * // Use it like any local component
 * document.body.appendChild(RemoteHeader());
 * ```
 */
export function defineRemoteComponent(name: string, loader: RemoteLoader): Component {
  let cached: Component | null = null;

  return function RemoteComponent(): HTMLElement {
    // Fast path: module already loaded
    if (cached) {
      return cached();
    }

    const container = div({
      class: "sibu-remote",
      "data-remote-component": name,
    }) as HTMLElement;

    // Show loading state
    container.appendChild(span({ class: "sibu-remote-loading" }, "Loading..."));

    // Owner liveness for this instance. The loader is an unbounded async gap:
    // a route can change, a list row can be removed, a boundary can reset —
    // all long before the module arrives. Instantiating the remote component
    // then would build DOM (and register effects and disposers) inside a
    // container nobody will ever dispose again, which is a guaranteed leak.
    let disposed = false;
    registerDisposer(container, () => {
      disposed = true;
    });

    loader()
      .then((mod) => {
        // The MODULE is shared, immutable, and expensive to fetch, so caching
        // it after disposal is correct and deliberate — the next instance
        // renders instantly. Only the INSTANTIATION is owner-scoped.
        cached = mod.default;
        if (disposed) return;
        replaceChildrenSafely(container, cached());
      })
      .catch((err) => {
        if (disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        replaceChildrenSafely(
          container,
          div({ class: "sibu-remote-error" }, `Failed to load remote component "${name}": ${message}`),
        );
      });

    return container;
  };
}

// --------------------------------------------------------------------------
// createSharedScope
// --------------------------------------------------------------------------

/**
 * Create a shared state scope that enables communication between independent
 * micro-frontend instances.
 *
 * Each key in the scope can be read, written, and subscribed to independently.
 * This is intentionally kept simpler than a full global store so micro-apps
 * can share data with minimal coupling.
 *
 * @example
 * ```ts
 * const shared = createSharedScope({ user: null, theme: "light" });
 *
 * // Micro-app A sets a value
 * shared.set("user", { name: "Alice" });
 *
 * // Micro-app B subscribes to changes
 * const unsub = shared.subscribe("user", (user) => {
 *   console.log("User changed:", user);
 * });
 *
 * // Later
 * unsub();
 * ```
 */
export function createSharedScope<T extends object>(initialState: T): SharedScope<T> {
  // Store a reactive signal per key
  const signals = new Map<keyof T, { get: () => T[keyof T]; set: (v: T[keyof T]) => void }>();

  // Subscriber sets per key
  const subscribers = new Map<keyof T, Set<(value: T[keyof T]) => void>>();

  // Initialise signals for every key in the initial state
  for (const key of Object.keys(initialState) as Array<keyof T>) {
    const [get, set] = signal<T[typeof key]>(initialState[key]);
    signals.set(key, { get, set });
    subscribers.set(key, new Set());
  }

  /**
   * Ensure a signal exists for a key. If the key was not part of the
   * initial state it is lazily created with `undefined` as the default.
   */
  function ensureSignal(key: keyof T) {
    if (!signals.has(key)) {
      const [get, set] = signal<T[keyof T]>(undefined as T[keyof T]);
      signals.set(key, { get, set });
      subscribers.set(key, new Set());
    }
  }

  function get<K extends keyof T>(key: K): T[K] {
    ensureSignal(key);
    return signals.get(key)?.get() as T[K];
  }

  function set<K extends keyof T>(key: K, value: T[K]): void {
    ensureSignal(key);
    signals.get(key)?.set(value);

    // Notify plain subscribers
    const subs = subscribers.get(key);
    if (subs) {
      for (const cb of subs) {
        cb(value);
      }
    }
  }

  function subscribe<K extends keyof T>(key: K, callback: (value: T[K]) => void): () => void {
    ensureSignal(key);
    const subs = subscribers.get(key);
    if (!subs) {
      return () => {};
    }
    subs.add(callback as (value: T[keyof T]) => void);
    return () => {
      subs.delete(callback as (value: T[keyof T]) => void);
    };
  }

  return { get, set, subscribe };
}
