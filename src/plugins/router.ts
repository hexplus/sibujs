import { dispose, registerDisposer } from "../core/rendering/dispose";
import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";
import { track } from "../reactivity/track";
import { sanitizeUrl } from "../utils/sanitize";

// ─── Navigation protocol guard ──────────────────────────────────────────────
//
// Block `javascript:`, `data:`, `vbscript:`, and `blob:` URIs from ever
// reaching `history.pushState`. Modern browsers do not execute a
// `javascript:` URI stored via pushState directly — but any subsequent
// render that copies `location.href` into an `<a href>` would turn it
// into a live XSS vector. Same for reflected links that use `routeState.path`.
//
// The allowlist is "path-ish strings" — we accept anything that does NOT
// look like a dangerous scheme. `sanitizeUrl` returns the empty string for
// blocked schemes, so we can reuse it.
function isSafeNavigationTarget(path: string): boolean {
  // An empty string from `sanitizeUrl` means the input was unsafe.
  // But an originally-empty input is also legitimate ("" → root relative),
  // so treat those separately.
  if (path === "") return true;
  return sanitizeUrl(path) !== "";
}

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export type Component = () => Element;
export type AsyncComponent = () => Promise<Element>;
export type LazyComponent = () => Promise<{ default: Component }>;
export type Params = Record<string, string>;

export interface RouteContext {
  readonly path: string;
  readonly params: Params;
  readonly query: Params;
  readonly hash: string;
  readonly meta: RouteMeta;
  readonly matched: RouteDef[];
}

export type GuardResult = boolean | string | Promise<boolean | string>;
export type Guard = (to: RouteContext, from?: RouteContext) => GuardResult;

export type NavigationGuard = (to: RouteContext, from: RouteContext, next: NavigationNext) => void;

export type NavigationNext = (result?: boolean | string | Error) => void;

export type RouteMeta = Record<string, unknown>;

export interface RouteBase {
  readonly path: string;
  readonly name?: string;
  readonly meta?: RouteMeta;
  readonly children?: RouteDef[];
  readonly beforeEnter?: Guard | Guard[];
  readonly alias?: string | string[];
}

export interface ComponentRoute extends RouteBase {
  readonly component: Component;
}

export interface AsyncRoute extends RouteBase {
  readonly component: AsyncComponent | LazyComponent;
}

export interface RedirectRoute extends RouteBase {
  readonly redirect: string | ((to: RouteContext) => string);
}

/**
 * A route whose component is loaded on first visit via a dynamic
 * `import()`. This is the ergonomic shorthand for
 * `{ component: lazy(() => import("./Page")) }`.
 *
 * The loader must return a module with a `default` Component export.
 */
export interface LazyRoute extends RouteBase {
  readonly lazy: () => Promise<{ default: Component }>;
}

export type RouteDef = ComponentRoute | AsyncRoute | RedirectRoute | LazyRoute;

export interface RouterOptions {
  readonly mode?: "history" | "hash";
  readonly base?: string;
  readonly linkActiveClass?: string;
  readonly linkExactActiveClass?: string;
  readonly fallback?: boolean;
  readonly scrollBehavior?: ScrollBehavior;
  readonly guardTimeout?: number;
  readonly cacheSize?: number;
  readonly errorRetryDelay?: number;
  readonly preloadStrategy?: "none" | "hover" | "visible";
  /**
   * Enable KeepAlive caching for route components.
   * - `true` — cache all routes
   * - string[] — cache only named routes matching these names
   * - number — cache all routes with this max cache size
   */
  readonly keepAlive?: boolean | string[] | number;
}

export type ScrollBehavior = (
  to: RouteContext,
  from: RouteContext,
  savedPosition: ScrollPosition | null,
) => ScrollPosition | null;

export interface ScrollPosition {
  readonly x: number;
  readonly y: number;
}

export interface NavigationFailure {
  readonly type: "aborted" | "cancelled" | "duplicated" | "timeout";
  readonly from: RouteContext;
  readonly to: RouteContext;
  readonly error?: Error;
}

export type NavigationResult =
  | { success: true; route: RouteContext }
  | { success: false; type: NavigationFailure["type"]; failure: NavigationFailure };

export type NavigationTarget =
  | string
  | { path?: string; name?: string; params?: Params; query?: Params; hash?: string };

// ============================================================================
// UTILITY CLASSES
// ============================================================================

/**
 * LRU Cache implementation with automatic cleanup
 */
class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private readonly maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = Math.max(1, maxSize);
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Remove least recently used
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Navigation controller for handling concurrent navigation attempts
 */
class NavigationController {
  private currentController: AbortController | null = null;

  async navigate(navigationFn: (signal: AbortSignal) => Promise<void>): Promise<void> {
    // Cancel current navigation
    if (this.currentController) {
      this.currentController.abort();
    }

    this.currentController = new AbortController();
    const signal = this.currentController.signal;

    try {
      await navigationFn(signal);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        // Navigation was cancelled, this is expected
        return;
      }
      throw error;
    } finally {
      if (this.currentController?.signal === signal) {
        this.currentController = null;
      }
    }
  }

  abort(): void {
    if (this.currentController) {
      this.currentController.abort();
      this.currentController = null;
    }
  }

  get isNavigating(): boolean {
    return this.currentController !== null;
  }
}

/**
 * Enhanced route matcher with trie optimization
 */
class RouteMatcher {
  private routeTrie = new Map<string, RouteDef>();
  private parentChain = new Map<string, RouteDef[]>();
  private namedRoutes = new Map<string, RouteDef>();
  private compiledPatterns = new LRUCache<string, { regex: RegExp; keys: string[] }>(50);

  constructor(routes: RouteDef[]) {
    this.buildIndex(routes);
  }

  private buildIndex(routes: RouteDef[], parentPath = "", ancestors: RouteDef[] = []): void {
    for (const route of routes) {
      const fullPath = parentPath + route.path;
      const chain = [...ancestors, route];

      // Index by path
      this.routeTrie.set(fullPath, route);
      this.parentChain.set(fullPath, chain);

      // Index by name
      if (route.name) {
        this.namedRoutes.set(route.name, route);
      }

      // Handle aliases
      if (route.alias) {
        const aliases = Array.isArray(route.alias) ? route.alias : [route.alias];
        for (const alias of aliases) {
          this.routeTrie.set(parentPath + alias, route);
          this.parentChain.set(parentPath + alias, chain);
        }
      }

      // Index children
      if (route.children?.length) {
        this.buildIndex(route.children, fullPath, chain);
      }
    }
  }

  match(path: string): { route: RouteDef; params: Params; matched: RouteDef[] } | null {
    // Try exact match first
    const exactMatch = this.routeTrie.get(path);
    if (exactMatch) {
      return { route: exactMatch, params: {}, matched: this.parentChain.get(path) || [exactMatch] };
    }

    // Try pattern matching
    for (const [routePath, route] of this.routeTrie) {
      const match = this.matchPattern(path, routePath);
      if (match) {
        return { route, params: match.params, matched: this.parentChain.get(routePath) || [route] };
      }
    }

    return null;
  }

  findByName(name: string): RouteDef | null {
    return this.namedRoutes.get(name) || null;
  }

  private matchPattern(path: string, routePath: string): { params: Params } | null {
    // Handle wildcard routes
    if (routePath === "*") {
      return { params: { pathMatch: path } };
    }
    if (routePath.endsWith("/*")) {
      const basePath = routePath.slice(0, -2);
      if (path === basePath || path.startsWith(`${basePath}/`)) {
        return { params: { pathMatch: path.slice(basePath.length) } };
      }
      return null;
    }

    // Get or compile pattern
    let compiled = this.compiledPatterns.get(routePath);
    if (!compiled) {
      compiled = this.compileRoute(routePath);
      this.compiledPatterns.set(routePath, compiled);
    }

    const match = path.match(compiled.regex);
    if (match) {
      const params: Params = {};
      compiled.keys.forEach((key, i) => {
        if (match[i + 1] !== undefined) {
          params[key] = decodeURIComponent(match[i + 1]);
        }
      });
      return { params };
    }

    return null;
  }

  private compileRoute(routePath: string): { regex: RegExp; keys: string[] } {
    const keys: string[] = [];

    // Escape regex special characters in literal path segments
    const escapeRegex = (s: string): string => s.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");

    // Split on parameter tokens (":name" or ":name?") to separate literals from params
    const parts = routePath.split(/(\/:[^/]+\??)/);
    let pattern = "";

    for (const part of parts) {
      if (part.startsWith("/:")) {
        // Optional parameter: /users/:id?
        if (part.endsWith("?")) {
          keys.push(part.slice(2, -1));
          pattern += "(?:/([^/]+))?";
        } else {
          // Regular parameter: /users/:id
          keys.push(part.slice(2));
          pattern += "/([^/]+)";
        }
      } else {
        // Literal path segment — escape regex chars
        pattern += escapeRegex(part);
      }
    }

    return {
      regex: new RegExp(`^${pattern}$`),
      keys,
    };
  }

  rebuild(routes: RouteDef[]): void {
    this.routeTrie.clear();
    this.parentChain.clear();
    this.namedRoutes.clear();
    this.compiledPatterns.clear();
    this.buildIndex(routes);
  }

  addRoute(route: RouteDef, parentPath = ""): void {
    const fullPath = parentPath + route.path;
    const parentAncestors = this.parentChain.get(parentPath) || [];
    const chain = [...parentAncestors, route];
    this.routeTrie.set(fullPath, route);
    this.parentChain.set(fullPath, chain);
    if (route.name) {
      this.namedRoutes.set(route.name, route);
    }
    if (route.children?.length) {
      this.buildIndex(route.children, fullPath, chain);
    }
  }

  removeRoute(path: string): void {
    this.routeTrie.delete(path);
    this.parentChain.delete(path);
    this.compiledPatterns.clear();
    // Remove from named routes
    for (const [name, route] of this.namedRoutes) {
      if (route.path === path) {
        this.namedRoutes.delete(name);
        break;
      }
    }
  }
}

/**
 * Guard manager with timeout and error handling
 */
class GuardManager {
  private beforeEachGuards: NavigationGuard[] = [];
  private beforeResolveGuards: NavigationGuard[] = [];
  private afterEachHooks: Array<(to: RouteContext, from: RouteContext) => void> = [];
  private timeout: number;

  constructor(timeout = 5000) {
    this.timeout = timeout;
  }

  async runBeforeEach(to: RouteContext, from: RouteContext, signal: AbortSignal): Promise<boolean | string> {
    for (const guard of this.beforeEachGuards) {
      if (signal.aborted) throw new Error("Navigation aborted");

      const result = await this.runGuard(guard, to, from, signal);
      if (result !== true) return result;
    }
    return true;
  }

  async runBeforeResolve(to: RouteContext, from: RouteContext, signal: AbortSignal): Promise<boolean | string> {
    for (const guard of this.beforeResolveGuards) {
      if (signal.aborted) throw new Error("Navigation aborted");

      const result = await this.runGuard(guard, to, from, signal);
      if (result !== true) return result;
    }
    return true;
  }

  runAfterEach(to: RouteContext, from: RouteContext): void {
    for (const hook of this.afterEachHooks) {
      try {
        hook(to, from);
      } catch (error) {
        console.error("[Router] AfterEach hook error:", error);
      }
    }
  }

  private runGuard(
    guard: NavigationGuard,
    to: RouteContext,
    from: RouteContext,
    signal: AbortSignal,
  ): Promise<boolean | string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Navigation aborted"));
        return;
      }

      let resolved = false;

      const next: NavigationNext = (result) => {
        if (resolved || signal.aborted) return;
        resolved = true;
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", abortHandler);

        if (result instanceof Error) {
          reject(result);
        } else if (result === false) {
          resolve(false);
        } else if (typeof result === "string") {
          resolve(result);
        } else {
          resolve(true);
        }
      };

      // Set up abort handler
      const abortHandler = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          reject(new Error("Navigation aborted"));
        }
      };

      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          signal.removeEventListener("abort", abortHandler);
          reject(new Error("Guard timeout"));
        }
      }, this.timeout);

      signal.addEventListener("abort", abortHandler);

      try {
        guard(to, from, next);
      } catch (error) {
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", abortHandler);
        if (!resolved) {
          resolved = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }

      // Note: cleanup (clearTimeout + removeEventListener) happens in the
      // next() callback, the catch block, the timeout handler, or the abort
      // handler — whichever resolves the guard first.
    });
  }

  addBeforeEach(guard: NavigationGuard): () => void {
    this.beforeEachGuards.push(guard);
    return () => {
      const index = this.beforeEachGuards.indexOf(guard);
      if (index > -1) this.beforeEachGuards.splice(index, 1);
    };
  }

  addBeforeResolve(guard: NavigationGuard): () => void {
    this.beforeResolveGuards.push(guard);
    return () => {
      const index = this.beforeResolveGuards.indexOf(guard);
      if (index > -1) this.beforeResolveGuards.splice(index, 1);
    };
  }

  addAfterEach(hook: (to: RouteContext, from: RouteContext) => void): () => void {
    this.afterEachHooks.push(hook);
    return () => {
      const index = this.afterEachHooks.indexOf(hook);
      if (index > -1) this.afterEachHooks.splice(index, 1);
    };
  }

  clear(): void {
    this.beforeEachGuards = [];
    this.beforeResolveGuards = [];
    this.afterEachHooks = [];
  }
}

/**
 * Component loader with caching and error recovery
 */
class ComponentLoader {
  private componentCache: LRUCache<string, Component>;
  private errorCache = new Map<string, { timestamp: number; count: number }>();
  private loadingPromises = new Map<string, Promise<Component>>();
  private retryDelay: number;

  constructor(cacheSize = 50, retryDelay = 1000) {
    this.componentCache = new LRUCache(cacheSize);
    this.retryDelay = retryDelay;
  }

  async loadComponent(route: RouteDef, routePath: string): Promise<Component> {
    if (!("component" in route)) {
      throw new Error(`Route ${routePath} does not have a component`);
    }

    const comp = route.component;

    // Return cached component
    const cached = this.componentCache.get(routePath);
    if (cached) return cached;

    // Check if there's already a loading promise
    const existingPromise = this.loadingPromises.get(routePath);
    if (existingPromise) return existingPromise;

    // Check error cache
    const errorInfo = this.errorCache.get(routePath);
    if (errorInfo && Date.now() - errorInfo.timestamp < this.retryDelay) {
      throw new Error(`Component loading failed recently, retry in ${this.retryDelay}ms`);
    }

    // Create loading promise
    const loadingPromise = this.doLoadComponent(comp, routePath);
    this.loadingPromises.set(routePath, loadingPromise);

    try {
      const component = await loadingPromise;
      this.componentCache.set(routePath, component);
      this.errorCache.delete(routePath); // Clear error on success
      return component;
    } catch (error) {
      // Update error cache
      const currentError = this.errorCache.get(routePath) || { timestamp: 0, count: 0 };
      this.errorCache.set(routePath, {
        timestamp: Date.now(),
        count: currentError.count + 1,
      });
      throw error;
    } finally {
      this.loadingPromises.delete(routePath);
    }
  }

  private async doLoadComponent(
    comp: Component | AsyncComponent | LazyComponent,
    routePath: string,
  ): Promise<Component> {
    // Synchronous component
    if (!this.isAsyncComponent(comp)) {
      const result = (comp as Component)();
      if (!this.isElement(result)) {
        throw new Error(`Component for route "${routePath}" must return Element, got ${typeof result}`);
      }
      return comp as Component;
    }

    // Async component
    try {
      const result = await (comp as AsyncComponent | LazyComponent)();
      const component = this.extractComponent(result, routePath);

      // Validate component
      const testElement = component();
      if (!this.isElement(testElement)) {
        throw new Error(`Component for route "${routePath}" must return Element, got ${typeof testElement}`);
      }

      return component;
    } catch (error) {
      const wrapped = new Error(
        `Failed to load component for route "${routePath}": ${error instanceof Error ? error.message : String(error)}`,
      );
      wrapped.cause = error;
      throw wrapped;
    }
  }

  private isAsyncComponent(comp: Component | AsyncComponent | LazyComponent): boolean {
    return (
      (comp as any)[LAZY_MARKER] === true ||
      comp.constructor.name === "AsyncFunction" ||
      (typeof comp === "function" && comp.toString().includes("import("))
    );
  }

  private isElement(value: unknown): value is Element {
    return value instanceof Element;
  }

  private extractComponent(result: Element | { default: Component } | Component, routePath: string): Component {
    if ("default" in result && typeof result.default === "function") {
      return result.default;
    }

    if (typeof result === "function") {
      return result;
    }

    if (this.isElement(result)) {
      return () => result;
    }

    throw new Error(`Invalid component module for route "${routePath}"`);
  }

  clearErrors(): void {
    this.errorCache.clear();
  }

  clearCache(): void {
    this.componentCache.clear();
    this.errorCache.clear();
    this.loadingPromises.clear();
  }
}

// ============================================================================
// MAIN ROUTER CLASS
// ============================================================================

export class SibuRouter {
  private options: Required<RouterOptions>;
  private matcher: RouteMatcher;
  private guards: GuardManager;
  private loader: ComponentLoader;
  private navigator: NavigationController;

  // State using proper getter/setter approach
  private currentRouteGetter: () => RouteContext;
  private currentRouteSetter: (value: RouteContext) => void;
  private isReadyGetter: () => boolean;
  private isReadySetter: (value: boolean) => void;

  // Event listeners cleanup
  private cleanup: Array<() => void> = [];

  constructor(routes: RouteDef[], options: RouterOptions = {}) {
    this.options = {
      mode: "history",
      base: "",
      linkActiveClass: "router-link-active",
      linkExactActiveClass: "router-link-exact-active",
      fallback: true,
      guardTimeout: 5000,
      cacheSize: 50,
      errorRetryDelay: 1000,
      preloadStrategy: "none",
      ...options,
    } as Required<RouterOptions>;

    // Initialize state properly
    const [currentRouteState, setCurrentRouteState] = signal<RouteContext>(this.createInitialRoute());
    const [isReadyState, setIsReadyState] = signal(false);

    this.currentRouteGetter = currentRouteState;
    this.currentRouteSetter = setCurrentRouteState;
    this.isReadyGetter = isReadyState;
    this.isReadySetter = setIsReadyState;

    this.matcher = new RouteMatcher(routes);
    this.guards = new GuardManager(this.options.guardTimeout);
    this.loader = new ComponentLoader(this.options.cacheSize, this.options.errorRetryDelay);
    this.navigator = new NavigationController();

    this.initialize();
  }

  private initialize(): void {
    // Set up event listeners
    if (this.options.mode === "history") {
      const popstateHandler = () => this.handleLocationChange(true);
      window.addEventListener("popstate", popstateHandler);
      this.cleanup.push(() => window.removeEventListener("popstate", popstateHandler));
    } else {
      const hashHandler = () => this.handleLocationChange(true);
      window.addEventListener("hashchange", hashHandler);
      this.cleanup.push(() => window.removeEventListener("hashchange", hashHandler));
    }

    // Set initial route
    queueMicrotask(() => {
      this.handleLocationChange(true);
      this.isReadySetter(true);
    });
  }

  private createInitialRoute(): RouteContext {
    return {
      path: "/",
      params: {},
      query: {},
      hash: "",
      meta: {},
      matched: [],
    };
  }

  private handleLocationChange(skipHistory = true): void {
    const path = this.getCurrentPath();
    this.navigate(path, { replace: true, skipHistory }).catch((err) => {
      console.error("[Router] Error during location change navigation:", err);
    });
  }

  private getCurrentPath(): string {
    const { mode, base } = this.options;

    if (mode === "hash") {
      return window.location.hash.slice(1) || "/";
    }

    let path = window.location.pathname;
    if (base && path.startsWith(base)) {
      path = path.slice(base.length);
    }

    return (path || "/") + window.location.search + window.location.hash;
  }

  private createRouteContext(fullPath: string): RouteContext {
    const [pathWithQuery, hash = ""] = fullPath.split("#");
    const [path, queryString = ""] = pathWithQuery.split("?");
    const query = Object.fromEntries(new URLSearchParams(queryString));

    const match = this.matcher.match(path || "/");
    const params = match?.params || {};
    const meta = match?.route.meta || {};
    const matched = match?.matched || [];

    return {
      path: path || "/",
      params,
      query,
      hash,
      meta,
      matched,
    };
  }

  // Public API
  async navigate(
    to: NavigationTarget,
    options: { replace?: boolean; state?: unknown; skipHistory?: boolean } = {},
  ): Promise<NavigationResult> {
    try {
      await this.navigator.navigate(async (signal) => {
        const targetPath = this.resolvePath(to);

        // Security: refuse navigation targets that carry a dangerous
        // protocol. `javascript:`, `data:`, `vbscript:`, and `blob:` URIs
        // can otherwise end up stored in `history.state` and reflected
        // into `<a href>` elements by downstream code.
        if (!isSafeNavigationTarget(targetPath)) {
          const from = this.currentRouteGetter();
          const toContext = this.createRouteContext(targetPath);
          throw new NavigationFailureError("aborted", from, toContext);
        }

        const from = this.currentRouteGetter();
        const toContext = this.createRouteContext(targetPath);

        // Check for duplicate navigation
        if (this.isSameRoute(from, toContext)) {
          throw new NavigationFailureError("duplicated", from, toContext);
        }

        await this.performNavigation(toContext, from, options, signal);
      });

      return { success: true, route: this.currentRouteGetter() };
    } catch (error) {
      if (error instanceof NavigationFailureError) {
        const failure = error.toFailure();
        return { success: false, type: failure.type, failure };
      }

      const failure: NavigationFailure = {
        type: "aborted",
        from: this.currentRouteGetter(),
        to: this.createRouteContext(this.resolvePath(to)),
        error: error instanceof Error ? error : new Error(String(error)),
      };

      return { success: false, type: failure.type, failure };
    }
  }

  private static readonly MAX_REDIRECT_DEPTH = 10;

  private async performNavigation(
    to: RouteContext,
    from: RouteContext,
    options: { replace?: boolean; state?: unknown; skipHistory?: boolean },
    signal: AbortSignal,
    depth = 0,
  ): Promise<void> {
    if (depth >= SibuRouter.MAX_REDIRECT_DEPTH) {
      throw new NavigationFailureError("aborted", from, to);
    }

    // Run beforeEach guards
    const beforeEachResult = await this.guards.runBeforeEach(to, from, signal);
    if (beforeEachResult !== true) {
      if (typeof beforeEachResult === "string") {
        // Security: refuse guard-redirect targets with dangerous protocols.
        if (!isSafeNavigationTarget(beforeEachResult)) {
          throw new NavigationFailureError("aborted", from, to);
        }
        return this.performNavigation(this.createRouteContext(beforeEachResult), from, options, signal, depth + 1);
      }
      throw new NavigationFailureError("aborted", from, to);
    }

    // Handle route-specific logic
    const match = this.matcher.match(to.path);
    if (match) {
      const { route } = match;

      // Run beforeEnter guards
      for (const matchedRoute of match.matched) {
        if ("beforeEnter" in matchedRoute && matchedRoute.beforeEnter) {
          const guards = Array.isArray(matchedRoute.beforeEnter)
            ? matchedRoute.beforeEnter
            : [matchedRoute.beforeEnter];
          for (const guard of guards) {
            if (signal.aborted) throw new Error("Navigation aborted");

            const result = await guard(to, from);
            if (result !== true) {
              if (typeof result === "string") {
                // Security: refuse guard-redirect targets with dangerous protocols.
                if (!isSafeNavigationTarget(result)) {
                  throw new NavigationFailureError("aborted", from, to);
                }
                return this.performNavigation(this.createRouteContext(result), from, options, signal, depth + 1);
              }
              throw new NavigationFailureError("aborted", from, to);
            }
          }
        }
      }

      // Handle redirects
      if ("redirect" in route) {
        const redirectPath = typeof route.redirect === "function" ? route.redirect(to) : route.redirect;
        // Refuse cross-origin / protocol-relative redirects by default —
        // these are open-redirect vectors (CWE-601) when redirect targets
        // are derived from untrusted route params.
        if (typeof redirectPath === "string" && /^(https?:)?\/\//i.test(redirectPath)) {
          if (typeof console !== "undefined") {
            console.error(
              `[SibuJS Router] Refusing absolute/protocol-relative redirect "${redirectPath}" — open-redirect risk.`,
            );
          }
          throw new NavigationFailureError("aborted", from, to);
        }
        if (typeof redirectPath === "string" && !isSafeNavigationTarget(redirectPath)) {
          throw new NavigationFailureError("aborted", from, to);
        }
        return this.performNavigation(this.createRouteContext(redirectPath), from, options, signal, depth + 1);
      }
    }

    // Run beforeResolve guards
    const beforeResolveResult = await this.guards.runBeforeResolve(to, from, signal);
    if (beforeResolveResult !== true) {
      if (typeof beforeResolveResult === "string") {
        // Security: refuse guard-redirect targets with dangerous protocols.
        if (!isSafeNavigationTarget(beforeResolveResult)) {
          throw new NavigationFailureError("aborted", from, to);
        }
        return this.performNavigation(this.createRouteContext(beforeResolveResult), from, options, signal, depth + 1);
      }
      throw new NavigationFailureError("aborted", from, to);
    }

    // Update browser history
    if (!options.skipHistory) {
      this.updateHistory(to, options);
    }

    // Update current route
    this.currentRouteSetter(to);

    // Run afterEach hooks
    this.guards.runAfterEach(to, from);

    // Handle scroll behavior
    this.handleScrollBehavior(to, from);
  }

  private resolvePath(to: NavigationTarget): string {
    if (typeof to === "string") return to;

    let path = to.path || "";

    // Handle named routes
    if (to.name && !path) {
      const namedRoute = this.matcher.findByName(to.name);
      if (namedRoute) {
        path = namedRoute.path;
      }
    }

    // Replace parameters
    if (to.params) {
      for (const [key, value] of Object.entries(to.params)) {
        path = path.replace(`:${key}`, encodeURIComponent(value));
      }
    }

    // Add query parameters
    if (to.query && Object.keys(to.query).length > 0) {
      path += `?${new URLSearchParams(to.query).toString()}`;
    }

    // Add hash
    if (to.hash) {
      path += `#${to.hash}`;
    }

    return path;
  }

  private isSameRoute(from: RouteContext, to: RouteContext): boolean {
    return (
      from.path === to.path &&
      JSON.stringify(from.params) === JSON.stringify(to.params) &&
      JSON.stringify(from.query) === JSON.stringify(to.query) &&
      from.hash === to.hash
    );
  }

  private updateHistory(to: RouteContext, options: { replace?: boolean; state?: unknown }): void {
    const fullPath =
      this.options.base +
      to.path +
      (Object.keys(to.query).length ? `?${new URLSearchParams(to.query).toString()}` : "") +
      (to.hash ? `#${to.hash}` : "");

    if (options.replace) {
      history.replaceState(options.state || {}, "", fullPath);
    } else {
      history.pushState(options.state || {}, "", fullPath);
    }
  }

  private handleScrollBehavior(to: RouteContext, from: RouteContext): void {
    if (this.options.scrollBehavior) {
      const scrollTo = this.options.scrollBehavior(to, from, null);
      if (scrollTo) {
        requestAnimationFrame(() => {
          window.scrollTo(scrollTo.x, scrollTo.y);
        });
      }
    }
  }

  // Component loading
  async loadComponent(route: RouteDef, routePath: string): Promise<Component> {
    return this.loader.loadComponent(route, routePath);
  }

  // Guards API
  beforeEach(guard: NavigationGuard): () => void {
    return this.guards.addBeforeEach(guard);
  }

  beforeResolve(guard: NavigationGuard): () => void {
    return this.guards.addBeforeResolve(guard);
  }

  afterEach(hook: (to: RouteContext, from: RouteContext) => void): () => void {
    return this.guards.addAfterEach(hook);
  }

  // Utility methods
  push(to: NavigationTarget): Promise<NavigationResult> {
    return this.navigate(to);
  }

  replace(to: NavigationTarget): Promise<NavigationResult> {
    return this.navigate(to, { replace: true });
  }

  go(delta: number): void {
    history.go(delta);
  }

  back(): void {
    history.back();
  }

  forward(): void {
    history.forward();
  }

  // State getters
  get currentRoute(): RouteContext {
    return this.currentRouteGetter();
  }

  get isReady(): boolean {
    return this.isReadyGetter();
  }

  get isNavigating(): boolean {
    return this.navigator.isNavigating;
  }

  // Cleanup
  destroy(): void {
    this.navigator.abort();
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.guards.clear();
    this.loader.clearCache();
    this.isReadySetter(false);
  }

  // Cache management
  clearCache(): void {
    this.loader.clearCache();
  }

  clearErrorCache(): void {
    this.loader.clearErrors();
  }

  // Route management
  updateRoutes(routes: RouteDef[]): void {
    this.matcher.rebuild(routes);
    this.clearCache();
  }

  /**
   * Add a route dynamically at runtime.
   */
  addRoute(route: RouteDef, parentPath?: string): void {
    this.matcher.addRoute(route, parentPath);
    this.clearCache();
  }

  /**
   * Remove a route by path.
   */
  removeRoute(path: string): void {
    this.matcher.removeRoute(path);
    this.clearCache();
  }

  /**
   * Get the reactive route getter for tracking.
   */
  get routeGetter(): () => RouteContext {
    return this.currentRouteGetter;
  }
}

// ============================================================================
// NAVIGATION FAILURE CLASS
// ============================================================================

class NavigationFailureError extends Error {
  type: NavigationFailure["type"];
  from: RouteContext;
  to: RouteContext;
  declare cause?: Error;

  constructor(type: NavigationFailure["type"], from: RouteContext, to: RouteContext, error?: Error) {
    super(`Navigation ${type}: from ${from.path} to ${to.path}`);
    this.name = "NavigationFailureError";
    this.type = type;
    this.from = from;
    this.to = to;
    if (error) {
      this.cause = error;
    }
  }

  toFailure(): NavigationFailure {
    return {
      type: this.type,
      from: this.from,
      to: this.to,
      error: this.cause instanceof Error ? this.cause : undefined,
    };
  }
}

// ============================================================================
// GLOBAL ROUTER INSTANCE (for compatibility)
// ============================================================================

let globalRouter: SibuRouter | null = null;

/**
 * Normalize a route tree so that any `{ lazy: () => import(...) }`
 * shorthand is converted to the canonical `{ component: lazy(...) }`
 * form used by the matcher. Runs recursively over `children`.
 */
function normalizeRoutes(routes: RouteDef[]): RouteDef[] {
  return routes.map((route) => {
    // Copy children first so we can rewrite them too
    const normalizedChildren =
      route.children && route.children.length > 0 ? normalizeRoutes(route.children as RouteDef[]) : route.children;

    if ("lazy" in route && typeof (route as LazyRoute).lazy === "function") {
      // Strip `lazy` and emit an AsyncRoute with `component: lazy(importFn)`
      const { lazy: importFn, ...rest } = route as LazyRoute;
      const asyncRoute: AsyncRoute = {
        ...(rest as RouteBase),
        component: lazy(importFn),
        children: normalizedChildren,
      };
      return asyncRoute;
    }

    // Preserve existing route, but replace children with the normalized list
    if (normalizedChildren !== route.children) {
      return { ...route, children: normalizedChildren } as RouteDef;
    }
    return route;
  });
}

export function createRouter(routesOrOptions: RouteDef[] | RouterOptions, options: RouterOptions = {}): SibuRouter {
  if (globalRouter) {
    globalRouter.destroy();
  }

  // Handle overload: createRouter(options) without routes array
  let routes: RouteDef[];
  if (Array.isArray(routesOrOptions)) {
    routes = normalizeRoutes(routesOrOptions);
  } else {
    options = routesOrOptions;
    routes = [];
  }

  globalRouter = new SibuRouter(routes, options);
  ensureRouterPagehide();
  return globalRouter;
}

/**
 * Set routes on the global router (replaces existing routes).
 */
export function setRoutes(routes: RouteDef[]): void {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");
  globalRouter.updateRoutes(normalizeRoutes(routes));
}

// ============================================================================
// COMPATIBILITY API (uses global router instance)
// ============================================================================

export function route(): RouteContext {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");
  return globalRouter.currentRoute;
}

export function router() {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");

  return {
    currentRoute: globalRouter.currentRoute,
    isReady: globalRouter.isReady,
    isNavigating: globalRouter.isNavigating,
    push: (to: NavigationTarget) => globalRouter?.push(to),
    replace: (to: NavigationTarget) => globalRouter?.replace(to),
    go: (delta: number) => globalRouter?.go(delta),
    back: () => globalRouter?.back(),
    forward: () => globalRouter?.forward(),
    beforeEach: (guard: NavigationGuard) => globalRouter?.beforeEach(guard),
    beforeResolve: (guard: NavigationGuard) => globalRouter?.beforeResolve(guard),
    afterEach: (hook: (to: RouteContext, from: RouteContext) => void) => globalRouter?.afterEach(hook),
  };
}

export function navigate(
  to: NavigationTarget,
  options?: { replace?: boolean; state?: unknown },
): Promise<NavigationResult> {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");
  return globalRouter.navigate(to, options);
}

export function push(to: NavigationTarget): Promise<NavigationResult> {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");
  return globalRouter.push(to);
}

export function replace(to: NavigationTarget): Promise<NavigationResult> {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");
  return globalRouter.replace(to);
}

export function go(delta: number): void {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");
  globalRouter.go(delta);
}

export function back(): void {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");
  globalRouter.back();
}

export function forward(): void {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");
  globalRouter.forward();
}

export function beforeEach(guard: NavigationGuard): () => void {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");
  return globalRouter.beforeEach(guard);
}

export function beforeResolve(guard: NavigationGuard): () => void {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");
  return globalRouter.beforeResolve(guard);
}

export function afterEach(hook: (to: RouteContext, from: RouteContext) => void): () => void {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");
  return globalRouter.afterEach(hook);
}

// ============================================================================
// ROUTE COMPONENT
// ============================================================================

// Registry of Route cleanup functions for destroyRouter
const routeCleanups: (() => void)[] = [];

export function Route(): Node {
  const anchor = document.createComment("route-outlet");
  let currentNode: Node | null = null;
  let loadingNode: Node | null = null;
  let errorNode: Node | null = null;
  let isUpdating = false;
  let currentPath = "";
  let currentTopRoute: RouteDef | null = null;

  const cleanupNodes = () => {
    [currentNode, loadingNode, errorNode].forEach((node) => {
      if (!node) return;
      // Run reactive disposers attached during route render BEFORE detaching.
      // Without dispose(), every effect/binding/listener inside the route
      // subtree leaks across navigations.
      dispose(node);
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    });
    currentNode = null;
    loadingNode = null;
    errorNode = null;
  };

  const showLoading = () => {
    if (!loadingNode && anchor.parentNode) {
      loadingNode = document.createElement("div");
      (loadingNode as HTMLElement).className = "route-loading";
      (loadingNode as HTMLElement).setAttribute("role", "status");
      (loadingNode as HTMLElement).setAttribute("aria-label", "Loading route");

      const spinner = document.createElement("div");
      spinner.className = "route-loading-spinner";
      spinner.setAttribute("aria-hidden", "true");

      const text = document.createElement("span");
      text.textContent = "Loading...";
      text.className = "route-loading-text";

      (loadingNode as HTMLElement).appendChild(spinner);
      (loadingNode as HTMLElement).appendChild(text);

      anchor.parentNode.insertBefore(loadingNode, anchor.nextSibling);
    }
  };

  const hideLoading = () => {
    if (loadingNode?.parentNode) {
      loadingNode.parentNode.removeChild(loadingNode);
      loadingNode = null;
    }
  };

  const showError = (error: Error, routeDef?: RouteDef) => {
    if (!anchor.parentNode) return;

    cleanupNodes();

    errorNode = document.createElement("div");
    (errorNode as HTMLElement).className = "route-error";
    (errorNode as HTMLElement).setAttribute("role", "alert");
    (errorNode as HTMLElement).setAttribute("aria-live", "assertive");

    // Attach component source info so the app layer can display it.
    // Extract the import path from the lazy function's source (e.g. import("./pages/Features.ts")).
    if (routeDef && "component" in routeDef) {
      const src = routeDef.component.toString();
      const importMatch = src.match(/import\(["']([^"']+)["']\)/);
      if (importMatch) {
        (errorNode as HTMLElement).setAttribute("data-component-source", importMatch[1]);
      }
      if (routeDef.component.name) {
        (errorNode as HTMLElement).setAttribute("data-component-name", routeDef.component.name);
      }
    }

    // Stash the original error so the app layer can access the real
    // stack trace and cause chain (DOM only carries text otherwise).
    (errorNode as HTMLElement & { __routeError?: Error }).__routeError = error;

    // SECURITY FIX: Use textContent instead of innerHTML to prevent XSS
    const title = document.createElement("h3");
    title.textContent = "Route Error";
    title.className = "route-error-title";

    const message = document.createElement("p");
    message.textContent = error.message || "Failed to load route component";
    message.className = "route-error-message";

    const retryButton = document.createElement("button");
    retryButton.textContent = "Retry";
    retryButton.className = "route-error-retry";
    retryButton.type = "button";
    const onRetryClick = () => {
      if (globalRouter) {
        globalRouter.clearErrorCache();
        update();
      }
    };
    retryButton.addEventListener("click", onRetryClick);
    // Pair the listener with a disposer so replacing the error node via
    // cleanupNodes() -> dispose() actually releases the closure capturing
    // globalRouter/update.
    registerDisposer(retryButton, () => retryButton.removeEventListener("click", onRetryClick));

    (errorNode as HTMLElement).appendChild(title);
    (errorNode as HTMLElement).appendChild(message);
    (errorNode as HTMLElement).appendChild(retryButton);

    anchor.parentNode.insertBefore(errorNode, anchor.nextSibling);
  };

  let pendingUpdate = false;

  const update = async () => {
    if (!globalRouter) return;
    if (isUpdating) {
      pendingUpdate = true;
      return;
    }

    const route = globalRouter.currentRoute;

    try {
      const match = globalRouter["matcher"].match(route.path);

      if (!match) {
        currentPath = route.path;
        currentTopRoute = null;
        cleanupNodes();
        return;
      }

      // For nested routes, render the top-level parent (which uses Outlet for children).
      // For flat routes, matched[0] is the route itself.
      const routeDef = match.matched[0] || match.route;

      // Skip re-render if the top-level route is the same (child routes handled by Outlet)
      if (routeDef === currentTopRoute && currentNode) {
        currentPath = route.path;
        return;
      }

      isUpdating = true;
      currentPath = route.path;
      currentTopRoute = routeDef;

      // Handle redirect routes (should be handled by router, but safety check)
      if ("redirect" in routeDef) {
        const redirectPath = typeof routeDef.redirect === "function" ? routeDef.redirect(route) : routeDef.redirect;

        queueMicrotask(() => {
          globalRouter?.navigate(redirectPath).catch((err) => {
            if (typeof console !== "undefined") console.error("[router] redirect failed:", err);
          });
        });
        return;
      }

      // Handle component routes
      if ("component" in routeDef) {
        try {
          // Show loading for async components
          const isAsync =
            routeDef.component.constructor.name === "AsyncFunction" ||
            routeDef.component.toString().includes("import(");

          if (isAsync) {
            showLoading();
          }

          const component = await globalRouter.loadComponent(routeDef, route.path);
          const node = component();

          if (node && anchor.parentNode && route.path === currentPath) {
            cleanupNodes();
            anchor.parentNode.insertBefore(node, anchor.nextSibling);
            currentNode = node;
          }
        } catch (error) {
          hideLoading();
          console.error("[Route] Component error:", error);
          showError(error instanceof Error ? error : new Error(String(error)), routeDef);
        }
      }
    } catch (error) {
      console.error("[Route] Update failed:", error);
      showError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      isUpdating = false;
      if (pendingUpdate) {
        pendingUpdate = false;
        update();
      }
    }
  };

  // Set up reactive tracking — track synchronously to register deps,
  // with microtask fallback if anchor isn't connected yet.
  let routeInitialized = false;
  const originalUpdate = update;
  const wrappedUpdate = async () => {
    await originalUpdate();
    routeInitialized = true;
  };
  const routeTeardown = track(wrappedUpdate);
  if (!routeInitialized) {
    queueMicrotask(() => {
      if (!routeInitialized && anchor.parentNode) wrappedUpdate();
    });
  }

  routeCleanups.push(() => {
    routeTeardown();
    cleanupNodes();
  });

  return anchor;
}

// ============================================================================
// KEEP-ALIVE ROUTE COMPONENT
// ============================================================================

/**
 * A route outlet that caches rendered components using KeepAlive.
 * Routes are preserved in the DOM cache so signals, form state, and scroll
 * position survive navigation.
 *
 * Uses the `keepAlive` option from RouterOptions if set, or accepts
 * explicit options.
 *
 * @param options Optional: override the router-level keepAlive setting
 *
 * @example
 * ```ts
 * // Cache all routes (max 10)
 * createRouter(routes, { keepAlive: 10 });
 * mount(() => div([nav, KeepAliveRoute()]), root);
 *
 * // Or cache specific routes by name
 * createRouter(routes, { keepAlive: ["dashboard", "settings"] });
 * mount(() => div([nav, KeepAliveRoute()]), root);
 *
 * // Or override per-outlet
 * KeepAliveRoute({ max: 5, include: ["dashboard"] })
 * ```
 */
export function KeepAliveRoute(options?: { max?: number; include?: string[] }): Node {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");

  const anchor = document.createComment("keep-alive-route");
  const cache = new Map<string, Node>();
  const lruOrder: string[] = [];

  // Resolve options from router config or explicit args
  const routerOpts = globalRouter["options"];
  const keepAliveOpt = routerOpts.keepAlive;
  const maxCache = options?.max ?? (typeof keepAliveOpt === "number" ? keepAliveOpt : 20);
  const includeNames = options?.include ?? (Array.isArray(keepAliveOpt) ? keepAliveOpt : undefined);

  let currentNode: Node | null = null;
  let currentKey = "";
  let currentCached = false;
  let isUpdating = false;
  let pendingUpdate = false;

  const update = async () => {
    if (!globalRouter) return;
    if (isUpdating) {
      pendingUpdate = true;
      return;
    }

    const route = globalRouter.currentRoute;
    const match = globalRouter["matcher"].match(route.path);
    if (!match) return;

    const { route: routeDef } = match;
    if ("redirect" in routeDef) {
      const redirectPath = typeof routeDef.redirect === "function" ? routeDef.redirect(route) : routeDef.redirect;
      queueMicrotask(() => {
        globalRouter?.navigate(redirectPath).catch((err) => {
          if (typeof console !== "undefined") console.error("[router] redirect failed:", err);
        });
      });
      return;
    }

    if (!("component" in routeDef)) return;

    const cacheKey = route.path;

    // Check if this route should be cached
    const shouldCache = !includeNames || (routeDef.name != null && includeNames.includes(routeDef.name));

    // Same route — skip
    if (cacheKey === currentKey && currentNode) return;

    isUpdating = true;
    const parent = anchor.parentNode;
    if (!parent) {
      isUpdating = false;
      return;
    }

    try {
      // Detach current node — dispose if it wasn't cached
      if (currentNode?.parentNode) {
        parent.removeChild(currentNode);
        if (!currentCached) {
          dispose(currentNode);
        }
      }

      if (shouldCache && cache.has(cacheKey)) {
        // Retrieve from cache
        currentNode = cache.get(cacheKey)!;
        currentCached = true;
        // Update LRU order
        const idx = lruOrder.indexOf(cacheKey);
        if (idx !== -1) {
          lruOrder.splice(idx, 1);
        }
        lruOrder.push(cacheKey);
      } else {
        // Create new
        const component = await globalRouter!.loadComponent(routeDef, route.path);
        const node = component();

        if (!node || route.path !== globalRouter!.currentRoute.path) {
          isUpdating = false;
          return;
        }

        currentNode = node;
        currentCached = shouldCache;

        if (shouldCache) {
          cache.set(cacheKey, node);
          lruOrder.push(cacheKey);

          // Evict oldest if over max
          while (lruOrder.length > maxCache) {
            const evictKey = lruOrder.shift()!;
            const evictNode = cache.get(evictKey);
            if (evictNode) {
              dispose(evictNode);
              if (evictNode.parentNode) evictNode.parentNode.removeChild(evictNode);
              cache.delete(evictKey);
            }
          }
        }
      }

      currentKey = cacheKey;
      if (currentNode) {
        parent.insertBefore(currentNode, anchor.nextSibling);
      }
    } catch (error) {
      console.error("[KeepAliveRoute] Component error:", error);
    } finally {
      isUpdating = false;
      if (pendingUpdate) {
        pendingUpdate = false;
        update();
      }
    }
  };

  let initialized = false;
  const wrappedUpdate = async () => {
    await update();
    initialized = true;
  };
  const kaTeardown = track(wrappedUpdate);
  if (!initialized) {
    queueMicrotask(() => {
      if (!initialized && anchor.parentNode) wrappedUpdate();
    });
  }

  routeCleanups.push(() => {
    kaTeardown();
    for (const node of cache.values()) {
      dispose(node);
      if (node.parentNode) node.parentNode.removeChild(node);
    }
    cache.clear();
    lruOrder.length = 0;
    if (currentNode?.parentNode) currentNode.parentNode.removeChild(currentNode);
    currentNode = null;
  });

  return anchor;
}

// ============================================================================
// ROUTER LINK COMPONENT
// ============================================================================

export function RouterLink(props: {
  to: NavigationTarget;
  replace?: boolean;
  activeClass?: string;
  exactActiveClass?: string;
  nodes?: string | Node | (string | Node)[];
  target?: string;
  rel?: string;
  [key: string]: unknown;
}): HTMLElement {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");

  const { to, replace = false, activeClass, exactActiveClass, nodes, target, rel, class: classAttr, ...attrs } = props;
  const baseClass = typeof classAttr === "string" ? classAttr : "";

  const routeGetter = globalRouter.routeGetter;
  const href = globalRouter["resolvePath"](to);
  const hrefPath = href.split("?")[0].split("#")[0];

  const link = document.createElement("a");
  link.href = href;

  // Set target and rel for security
  if (target) {
    link.target = target;
    // Security: Add rel="noopener noreferrer" for external links
    if (target === "_blank") {
      link.rel = rel ? `${rel} noopener noreferrer` : "noopener noreferrer";
    } else if (rel) {
      link.rel = rel;
    }
  } else if (rel) {
    link.rel = rel;
  }

  // Reactively update active classes when route changes
  const options = globalRouter["options"];
  const effectCleanup = effect(() => {
    const route = routeGetter();
    const isActive = route.path.startsWith(hrefPath);
    const isExactActive = route.path === hrefPath;

    const classes: string[] = [];
    if (isActive) {
      if (activeClass) classes.push(activeClass);
      else if (options.linkActiveClass) classes.push(options.linkActiveClass);
    }
    if (isExactActive) {
      if (exactActiveClass) classes.push(exactActiveClass);
      else if (options.linkExactActiveClass) classes.push(options.linkExactActiveClass);
    }
    link.className = [baseClass, ...classes].filter(Boolean).join(" ");
  });
  registerDisposer(link, effectCleanup);

  // Set other attributes (sanitize to prevent XSS)
  Object.entries(attrs).forEach(([key, value]) => {
    if (key.startsWith("on") || key === "href") return; // Skip event handlers and href
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      link.setAttribute(key, String(value));
    }
  });

  // Set content
  if (typeof nodes === "string") {
    link.textContent = nodes;
  } else if (nodes instanceof Node) {
    link.appendChild(nodes);
  } else if (Array.isArray(nodes)) {
    nodes.forEach((child) => {
      if (typeof child === "string") {
        link.appendChild(document.createTextNode(child));
      } else if (child instanceof Node) {
        link.appendChild(child);
      }
    });
  }

  // Handle click for internal navigation
  const onLinkClick = (e: MouseEvent) => {
    if (target || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    e.preventDefault();
    globalRouter?.navigate(to, { replace }).catch((err) => {
      if (typeof console !== "undefined") console.error("[router] link navigate failed:", err);
    });
  };
  link.addEventListener("click", onLinkClick);
  registerDisposer(link, () => {
    link.removeEventListener("click", onLinkClick);
  });

  return link;
}

// ============================================================================
// SUSPENSE COMPONENT (for code splitting)
// ============================================================================

export function Suspense(props: {
  fallback?: () => HTMLElement | HTMLElement;
  nodes: () => HTMLElement | Promise<HTMLElement>;
}): Node {
  const anchor = document.createComment("suspense-boundary");
  let currentNode: Node | null = null;
  let fallbackNode: Node | null = null;
  let isLoading = false;

  const cleanupNodes = () => {
    [currentNode, fallbackNode].forEach((node) => {
      if (node?.parentNode) {
        node.parentNode.removeChild(node);
      }
    });
    currentNode = null;
    fallbackNode = null;
  };

  const showFallback = () => {
    if (fallbackNode || !props.fallback || !anchor.parentNode) return;

    try {
      const fallback = typeof props.fallback === "function" ? props.fallback() : props.fallback;

      if (fallback instanceof HTMLElement) {
        fallbackNode = fallback;
        anchor.parentNode.insertBefore(fallbackNode, anchor.nextSibling);
      }
    } catch (error) {
      console.error("[Suspense] Fallback error:", error);
    }
  };

  const hideFallback = () => {
    if (fallbackNode?.parentNode) {
      fallbackNode.parentNode.removeChild(fallbackNode);
      fallbackNode = null;
    }
  };

  const render = async () => {
    if (isLoading) return;
    isLoading = true;

    try {
      const result = props.nodes();

      if (result instanceof Promise) {
        showFallback();
        const element = await result;

        if (anchor.parentNode) {
          cleanupNodes();
          anchor.parentNode.insertBefore(element, anchor.nextSibling);
          currentNode = element;
        }
      } else {
        if (anchor.parentNode) {
          cleanupNodes();
          anchor.parentNode.insertBefore(result, anchor.nextSibling);
          currentNode = result;
        }
      }
    } catch (error) {
      hideFallback();
      console.error("[Suspense] Nodes error:", error);

      // Show error in place of content
      if (anchor.parentNode) {
        const errorElement = document.createElement("div");
        errorElement.className = "suspense-error";
        errorElement.textContent = error instanceof Error ? error.message : "Failed to load";

        cleanupNodes();
        anchor.parentNode.insertBefore(errorElement, anchor.nextSibling);
        currentNode = errorElement;
      }
    } finally {
      isLoading = false;
    }
  };

  queueMicrotask(render);

  return anchor;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const LAZY_MARKER = Symbol.for("sibujs:lazy");

/**
 * Creates a lazy-loaded component.
 * Marks the function with a symbol so the router can detect it reliably
 * (no AsyncFunction heuristic needed).
 */
export function lazy(importFn: () => Promise<{ default: Component }>): LazyComponent {
  (importFn as any)[LAZY_MARKER] = true;
  return importFn;
}

/**
 * Preloads a route component
 */
export async function preloadRoute(to: NavigationTarget): Promise<void> {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");

  const path = globalRouter["resolvePath"](to);
  const match = globalRouter["matcher"].match(path.split("?")[0].split("#")[0]);

  if (match && "component" in match.route) {
    try {
      await globalRouter.loadComponent(match.route, path);
    } catch (error) {
      console.warn("[Router] Preload failed:", error);
    }
  }
}

/**
 * Validates if a route exists
 */
export function hasRoute(name: string): boolean {
  if (!globalRouter) return false;
  return globalRouter["matcher"].findByName(name) !== null;
}

/**
 * Gets route information by name
 */
export function getRouteInfo(name: string): RouteDef | null {
  if (!globalRouter) return null;
  return globalRouter["matcher"].findByName(name);
}

/**
 * Builds a URL for a route
 */
export function buildURL(to: NavigationTarget): string {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");
  return globalRouter["resolvePath"](to);
}

// ============================================================================
// CLEANUP
// ============================================================================

export function destroyRouter(): void {
  // Clean up Route-rendered DOM nodes
  for (const fn of routeCleanups) fn();
  routeCleanups.length = 0;

  if (globalRouter) {
    globalRouter.destroy();
    globalRouter = null;
  }
}

// Cleanup on page unload.
// Use `pagehide` instead of `beforeunload` so the browser's back/forward
// cache (bfcache) is not disabled. Only actually destroy when the page is
// being discarded (persisted === false); if it may be restored from bfcache,
// keep the router intact so a user returning via Back sees a working app.
//
// Previously registered at module top-level — that contradicts the package's
// `sideEffects: false` claim and fires per-import in test/HMR loops. Now
// installed lazily on first `createRouter()` call and de-duplicated via
// the `_routerPagehideHandler` module variable.
let _routerPagehideHandler: ((event: PageTransitionEvent) => void) | null = null;

function ensureRouterPagehide(): void {
  if (_routerPagehideHandler || typeof window === "undefined") return;
  _routerPagehideHandler = (event: PageTransitionEvent) => {
    if (event.persisted === false) {
      destroyRouter();
    }
  };
  window.addEventListener("pagehide", _routerPagehideHandler);
}

/**
 * Remove the module-level `pagehide` listener. Intended for HMR and tests —
 * normal apps never need to call this (the listener is page-lifetime).
 *
 * @internal
 */
export function __removeRouterPagehideHandler(): void {
  if (_routerPagehideHandler && typeof window !== "undefined") {
    window.removeEventListener("pagehide", _routerPagehideHandler);
    _routerPagehideHandler = null;
  }
}

// ============================================================================
// OUTLET COMPONENT (for nested routes / layouts)
// ============================================================================

/**
 * Outlet renders the child route component within a layout.
 * Use inside a parent route's component to render matched children.
 */
export function Outlet(): Node {
  const anchor = document.createComment("route-outlet-nested");
  let currentNode: Node | null = null;

  const update = async () => {
    if (!globalRouter) return;
    const route = globalRouter.currentRoute;
    if (route.matched.length < 2) return;

    // Render the deepest matched route's component
    const childRoute = route.matched[route.matched.length - 1];
    if (!childRoute || !("component" in childRoute)) return;

    try {
      // Use a composite cache key so parent and child don't collide
      const cacheKey = `${route.path}\0${childRoute.path}`;
      const component = await globalRouter.loadComponent(childRoute, cacheKey);
      const node = component();

      if (node && anchor.parentNode) {
        if (currentNode?.parentNode) {
          currentNode.parentNode.removeChild(currentNode);
        }
        anchor.parentNode.insertBefore(node, anchor.nextSibling);
        currentNode = node;
      }
    } catch (error) {
      console.error("[Outlet] Failed to render child route:", error);
    }
  };

  const outletTeardown = track(update);
  if (!anchor.parentNode) {
    queueMicrotask(() => {
      if (anchor.parentNode) update();
    });
  }
  routeCleanups.push(() => {
    outletTeardown();
    if (currentNode) {
      dispose(currentNode);
      if (currentNode.parentNode) currentNode.parentNode.removeChild(currentNode);
      currentNode = null;
    }
  });
  return anchor;
}

// ============================================================================
// DYNAMIC ROUTE MANAGEMENT
// ============================================================================

/**
 * Add a route at runtime.
 */
export function addRoute(route: RouteDef, parentPath?: string): void {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");
  globalRouter.addRoute(route, parentPath);
}

/**
 * Remove a route at runtime.
 */
export function removeRoute(path: string): void {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");
  globalRouter.removeRoute(path);
}

// ============================================================================
// ROUTER STATE MANAGEMENT
// ============================================================================

/**
 * routerState provides centralized reactive access to router state.
 */
export function routerState(): {
  currentPath: () => string;
  params: () => Params;
  query: () => Params;
  hash: () => string;
  meta: () => RouteMeta;
  isNavigating: () => boolean;
  isReady: () => boolean;
} {
  if (!globalRouter) throw new Error("Router not initialized. Call createRouter() first.");

  const router = globalRouter;
  return {
    currentPath: () => router.currentRoute.path,
    params: () => router.currentRoute.params,
    query: () => router.currentRoute.query,
    hash: () => router.currentRoute.hash,
    meta: () => router.currentRoute.meta,
    isNavigating: () => router.isNavigating,
    isReady: () => router.isReady,
  };
}

// ============================================================================
// ROUTER PLUGIN ECOSYSTEM
// ============================================================================

export interface RouterPlugin {
  name: string;
  onNavigate?: (to: RouteContext, from: RouteContext) => void;
  onError?: (error: Error, to: RouteContext) => void;
  onReady?: () => void;
}

const routerPlugins: RouterPlugin[] = [];

/**
 * Register a router plugin (analytics, breadcrumbs, permissions, etc.).
 */
export function routerPlugin(plugin: RouterPlugin): () => void {
  routerPlugins.push(plugin);

  // If router is ready, call onReady
  if (globalRouter?.isReady && plugin.onReady) {
    plugin.onReady();
  }

  // Register afterEach to notify plugins
  let removeGuard: (() => void) | null = null;
  if (globalRouter && plugin.onNavigate) {
    removeGuard = globalRouter.afterEach((to, from) => {
      plugin.onNavigate?.(to, from);
    });
  }

  return () => {
    const idx = routerPlugins.indexOf(plugin);
    if (idx !== -1) routerPlugins.splice(idx, 1);
    removeGuard?.();
  };
}

// ============================================================================
// ROUTE TRANSITIONS
// ============================================================================

export interface RouteTransitionOptions {
  enterClass?: string;
  leaveClass?: string;
  duration?: number;
}

let _routeTransitionOptions: RouteTransitionOptions | null = null;

/**
 * Configure route transition animations.
 */
export function setRouteTransition(options: RouteTransitionOptions): void {
  _routeTransitionOptions = options;
}

/**
 * Get current route transition options.
 */
export function getRouteTransition(): RouteTransitionOptions | null {
  return _routeTransitionOptions;
}

// ============================================================================
// MEMORY ROUTER (for testing)
// ============================================================================

/**
 * createMemoryRouter creates a router that doesn't interact with browser history.
 * Useful for testing and SSR.
 */
export function createMemoryRouter(
  routes: RouteDef[],
  _initialPath = "/",
): {
  router: SibuRouter;
  currentPath: () => string;
  push: (path: string) => Promise<NavigationResult>;
} {
  // Override mode to avoid browser history
  const router = createRouter(routes, { mode: "hash" });

  return {
    router,
    currentPath: () => router.currentRoute.path,
    push: (path: string) => router.push(path),
  };
}
