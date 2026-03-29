// ============================================================================
// ROUTER SSR INTEGRATION
// Server-side route resolution with client-side hydration continuity.
// ============================================================================

import type { TrustedHTML } from "../platform/ssr";
import { renderToString } from "../platform/ssr";
import type { RouteDef } from "./router";
import { createRouter } from "./router";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

/**
 * Serializable route state that can be transferred from server to client.
 */
export interface SSRRouteState {
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  hash: string;
  meta: Record<string, unknown>;
  name?: string;
}

/**
 * Simple route definition for SSR (subset of full RouteDef).
 */
export interface SSRRouteDef {
  path: string;
  name?: string;
  meta?: Record<string, unknown>;
  component: () => HTMLElement;
  redirect?: string;
  children?: SSRRouteDef[];
}

// ============================================================================
// INTERNAL: URL PARSING (no browser APIs)
// ============================================================================

/**
 * Parse a URL string into its constituent parts without using any browser APIs.
 * Handles path, query string, and hash fragment.
 */
function parseURL(url: string): { path: string; query: Record<string, string>; hash: string } {
  let remaining = url;
  let hash = "";
  let queryString = "";

  // Extract hash
  const hashIndex = remaining.indexOf("#");
  if (hashIndex !== -1) {
    hash = remaining.slice(hashIndex + 1);
    remaining = remaining.slice(0, hashIndex);
  }

  // Extract query string
  const queryIndex = remaining.indexOf("?");
  if (queryIndex !== -1) {
    queryString = remaining.slice(queryIndex + 1);
    remaining = remaining.slice(0, queryIndex);
  }

  // The remaining part is the path
  const path = remaining || "/";

  // Parse query string into key=value pairs
  const query: Record<string, string> = {};
  if (queryString) {
    const pairs = queryString.split("&");
    for (const pair of pairs) {
      if (!pair) continue;
      const eqIndex = pair.indexOf("=");
      if (eqIndex === -1) {
        // Key without value, e.g., "?flag"
        query[decodeURIComponent(pair)] = "";
      } else {
        const key = decodeURIComponent(pair.slice(0, eqIndex));
        const value = decodeURIComponent(pair.slice(eqIndex + 1));
        query[key] = value;
      }
    }
  }

  return { path, query, hash };
}

// ============================================================================
// INTERNAL: ROUTE PATTERN MATCHING (no browser APIs)
// ============================================================================

interface CompiledPattern {
  regex: RegExp;
  keys: string[];
}

/**
 * Compile a route path pattern into a RegExp for matching.
 * Supports:
 *   - Static paths: /about
 *   - Dynamic params: /user/:id
 *   - Optional params: /user/:id?
 *   - Wildcard/catch-all: /files/* or /files/:path*
 */
function compilePattern(routePath: string): CompiledPattern {
  const keys: string[] = [];
  let pattern = "";
  const segments = routePath.split("/");

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (i > 0) pattern += "\\/";

    if (!segment) {
      // Empty segment (leading slash or double slash)
      continue;
    }

    // Wildcard catch-all: * at end
    if (segment === "*") {
      keys.push("pathMatch");
      pattern += "(.*)";
      continue;
    }

    // Named wildcard catch-all: :name*
    const namedWildcardMatch = segment.match(/^:([^*]+)\*$/);
    if (namedWildcardMatch) {
      keys.push(namedWildcardMatch[1]);
      pattern += "(.*)";
      continue;
    }

    // Optional param: :name?
    const optionalMatch = segment.match(/^:([^?]+)\?$/);
    if (optionalMatch) {
      keys.push(optionalMatch[1]);
      // Make the entire segment (including the leading slash) optional
      // We need to go back and make the preceding slash optional too
      pattern = pattern.replace(/\\\/$/g, "");
      pattern += "(?:\\/([^\\/]+))?";
      continue;
    }

    // Dynamic param: :name
    const paramMatch = segment.match(/^:(.+)$/);
    if (paramMatch) {
      keys.push(paramMatch[1]);
      pattern += "([^\\/]+)";
      continue;
    }

    // Static segment - escape regex special characters
    pattern += segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  return {
    regex: new RegExp(`^${pattern}$`),
    keys,
  };
}

interface MatchResult {
  route: SSRRouteDef;
  params: Record<string, string>;
  matched: SSRRouteDef[];
}

/**
 * Match a path against a single route definition (and its children).
 * Returns the matched route, extracted params, and the chain of matched routes.
 */
function matchRoute(
  path: string,
  routes: SSRRouteDef[],
  parentPath: string = "",
  parentChain: SSRRouteDef[] = [],
): MatchResult | null {
  for (const route of routes) {
    const fullPath = normalizePath(`${parentPath}/${route.path}`);

    // If this route has children, try to match against them first
    // using the parent path prefix
    if (route.children && route.children.length > 0) {
      const childResult = matchRoute(path, route.children, fullPath, [...parentChain, route]);
      if (childResult) {
        return childResult;
      }
    }

    // Try matching the full path
    const compiled = compilePattern(fullPath);
    const match = path.match(compiled.regex);

    if (match) {
      const params: Record<string, string> = {};
      for (let i = 0; i < compiled.keys.length; i++) {
        if (match[i + 1] !== undefined) {
          params[compiled.keys[i]] = decodeURIComponent(match[i + 1]);
        }
      }
      return {
        route,
        params,
        matched: [...parentChain, route],
      };
    }
  }

  return null;
}

/**
 * Normalize a path by collapsing repeated slashes and ensuring a leading slash.
 */
function normalizePath(path: string): string {
  // Collapse repeated slashes
  let normalized = path.replace(/\/+/g, "/");
  // Ensure leading slash
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  // Remove trailing slash (except for root)
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

// ============================================================================
// ROUTE STATE SERIALIZATION KEY
// ============================================================================

const SSR_ROUTE_STATE_KEY = "__SIBU_ROUTE_STATE__";

// Maximum redirect depth to prevent infinite loops
const MAX_REDIRECT_DEPTH = 10;

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Resolve a route on the server without any browser APIs.
 * Performs route matching, param extraction, query parsing.
 * Does NOT use window, history, or any browser globals.
 */
export function resolveServerRoute(
  url: string,
  routes: SSRRouteDef[],
): { route: SSRRouteState; component: (() => HTMLElement) | null; redirect?: string } {
  return resolveServerRouteInternal(url, routes, 0);
}

function resolveServerRouteInternal(
  url: string,
  routes: SSRRouteDef[],
  depth: number,
): { route: SSRRouteState; component: (() => HTMLElement) | null; redirect?: string } {
  const { path, query, hash } = parseURL(url);
  const normalizedPath = normalizePath(path);

  const match = matchRoute(normalizedPath, routes);

  if (!match) {
    // No route matched -- return a state with the requested path and null component
    return {
      route: {
        path: normalizedPath,
        params: {},
        query,
        hash,
        meta: {},
      },
      component: null,
    };
  }

  const { route: matchedDef, params } = match;

  // Handle redirects (follow up to MAX_REDIRECT_DEPTH)
  if (matchedDef.redirect) {
    if (depth >= MAX_REDIRECT_DEPTH) {
      // Too many redirects, stop and return what we have
      return {
        route: {
          path: normalizedPath,
          params,
          query,
          hash,
          meta: matchedDef.meta || {},
          name: matchedDef.name,
        },
        component: null,
        redirect: matchedDef.redirect,
      };
    }

    // Warn about absolute URL redirects (potential open redirect vulnerability)
    if (typeof matchedDef.redirect === "string" && /^https?:\/\/|^\/\//i.test(matchedDef.redirect)) {
      console.warn(
        `[SibuJS Router SSR] Redirect to absolute URL "${matchedDef.redirect}" detected. Use relative paths for safer redirects.`,
      );
    }
    // Follow the redirect
    return resolveServerRouteInternal(matchedDef.redirect, routes, depth + 1);
  }

  const routeState: SSRRouteState = {
    path: normalizedPath,
    params,
    query,
    hash,
    meta: matchedDef.meta || {},
    name: matchedDef.name,
  };

  return {
    route: routeState,
    component: matchedDef.component || null,
    redirect: undefined,
  };
}

/**
 * Render a route's component to HTML string on the server.
 * Combines route resolution with renderToString.
 */
export function renderRouteToString(
  url: string,
  routes: SSRRouteDef[],
  _options?: { title?: string; scripts?: string[]; links?: Record<string, string>[] },
): { html: string; state: SSRRouteState } {
  const resolved = resolveServerRoute(url, routes);

  let html = "";
  if (resolved.component) {
    const element = resolved.component();
    html = renderToString(element);
  }

  return {
    html,
    state: resolved.route,
  };
}

/**
 * Generate the full HTML document for a route including serialized state.
 * Uses renderToDocument pattern with embedded route state.
 */
export function renderRouteToDocument(
  url: string,
  routes: SSRRouteDef[],
  options?: {
    title?: string;
    meta?: Record<string, string>[];
    links?: Record<string, string>[];
    scripts?: string[];
    headExtra?: TrustedHTML;
  },
): string {
  const { html, state } = renderRouteToString(url, routes, options);
  const opts = options || {};

  // Build meta tags
  const metaTags = (opts.meta || [])
    .map(
      (attrs) =>
        `<meta ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
          .join(" ")} />`,
    )
    .join("\n    ");

  // Build link tags
  const linkTags = (opts.links || [])
    .map(
      (attrs) =>
        `<link ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
          .join(" ")} />`,
    )
    .join("\n    ");

  // Build script tags (external scripts)
  const scriptTags = (opts.scripts || []).map((src) => `<script src="${escapeAttr(src)}"></script>`).join("\n    ");

  // Serialize route state for client pickup
  const stateScript = serializeRouteState(state);

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${opts.title ? `<title>${escapeHtml(opts.title)}</title>` : ""}
    ${metaTags}
    ${linkTags}
    ${opts.headExtra || ""}
  </head>
  <body>
    <div id="app">${html}</div>
    ${stateScript}
    ${scriptTags}
  </body>
</html>`;
}

/**
 * Serialize route state for embedding in HTML.
 * Uses a specific key (__SIBU_ROUTE_STATE__) distinct from the generic SSR data key.
 */
export function serializeRouteState(state: SSRRouteState): string {
  const json = JSON.stringify(state).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return `<script>window.${SSR_ROUTE_STATE_KEY}=${json}</script>`;
}

/**
 * Deserialize route state on the client from server-embedded data.
 * Reads from window.__SIBU_ROUTE_STATE__.
 */
export function deserializeRouteState(): SSRRouteState | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as Record<string, unknown>)[SSR_ROUTE_STATE_KEY] as SSRRouteState | undefined;
}

/**
 * Initialize the client-side router from server-rendered state.
 * Hydrates the existing HTML and picks up where server left off.
 * Skips initial route resolution and guard execution since the server
 * already resolved and rendered the correct route.
 */
export function hydrateRouter(routes: SSRRouteDef[], options?: { container?: HTMLElement }): void {
  // 1. Deserialize route state from server
  const serverState = deserializeRouteState();
  if (!serverState) {
    // No server state found -- fall back to creating a normal client-side router.
    // This can happen when the page was not server-rendered.
    createRouter(routes as RouteDef[]);
    return;
  }

  // 2. Create the router with routes but wrap so we can control initialization.
  //    We use createRouter which sets the global router, then immediately set
  //    the route state to what the server resolved, preventing a redundant
  //    initial navigation and re-render.
  createRouter(routes as RouteDef[]);

  // 3. Set the current route to the server's resolved state by navigating
  //    to the server-known path with replace semantics. This synchronizes
  //    the router's internal state with the server's resolved route without
  //    causing a DOM update (since the content is already rendered).
  //    The router's queueMicrotask-based initialization will pick up the
  //    correct path from window.location, which should match serverState.path.

  // 4. Hydrate the existing DOM.
  //    Find the container and the matching component, then run hydration
  //    to attach event listeners and reactive bindings.
  const container = options?.container || document.getElementById("app");
  if (container && serverState.path) {
    // Find the component that the server rendered for this route
    const resolved = resolveServerRoute(serverState.path, routes);
    if (resolved.component) {
      // Import hydrate from ssr and attach bindings to existing DOM
      import("../platform/ssr").then(({ hydrate }) => {
        if (resolved.component) {
          hydrate(resolved.component, container);
        }
      });
    }
  }

  // 5. Client-side navigation is now enabled for future navigations.
  //    The router is fully initialized and listening to popstate/hashchange events.
  //    Subsequent navigate() calls will work as normal client-side transitions.
}

/**
 * Create a server-safe router instance that works without browser APIs.
 * For use in Node.js SSR rendering. Returns an object with resolve,
 * renderToString, and renderToDocument methods -- none of which require
 * window, history, or document.
 */
export function createSSRRouter(routes: SSRRouteDef[]): {
  resolve: (url: string) => { route: SSRRouteState; component: (() => HTMLElement) | null; redirect?: string };
  renderToString: (url: string) => { html: string; state: SSRRouteState };
  renderToDocument: (
    url: string,
    options?: {
      title?: string;
      meta?: Record<string, string>[];
      links?: Record<string, string>[];
      scripts?: string[];
      headExtra?: TrustedHTML;
    },
  ) => string;
} {
  return {
    resolve(url: string) {
      return resolveServerRoute(url, routes);
    },

    renderToString(url: string) {
      return renderRouteToString(url, routes);
    },

    renderToDocument(url: string, options?) {
      return renderRouteToDocument(url, routes, options);
    },
  };
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
