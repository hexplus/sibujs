// ============================================================================
// ROUTER SSR INTEGRATION
// Server-side route resolution with client-side hydration continuity.
// ============================================================================
//
// Security notes (see WORK_LOG.md § "SSR security hardening"):
//
//  - `params` and `query` objects are created with `Object.create(null)`
//    and guarded against prototype-pollution keys (`__proto__`, `constructor`,
//    `prototype`). A route like `/:__proto__` cannot poison `Object.prototype`.
//  - `parseURL` wraps `decodeURIComponent` in try/catch so malformed
//    percent-sequences do not crash server-side rendering (DoS vector).
//  - `serializeRouteState` escapes `<`, `>`, `&`, `U+2028`, `U+2029` and
//    supports an optional `nonce` for strict-CSP compatibility.

import { escapeScriptJson, renderToString, type TrustedHTML } from "../platform/ssr";
import { isUnsafeKey } from "../utils/guards";
import { serializeHeadEntry } from "../utils/headEntry";
import { sanitizeUrl } from "../utils/sanitize";
import type { RouteDef } from "./router";
import { __getNavigationEpoch, createRouter } from "./router";

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
// INTERNAL: SECURITY HELPERS
// ============================================================================

/** `decodeURIComponent` that never throws. Returns the raw input on malformed percent-sequences. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Create a plain object without `Object.prototype` in its chain, for use as an untrusted-key map. */
function nullObject(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

// ============================================================================
// INTERNAL: URL PARSING (no browser APIs)
// ============================================================================

/**
 * Parse a URL string into its constituent parts without using any browser APIs.
 * Handles path, query string, and hash fragment.
 *
 * Security: resilient to malformed percent-sequences (never throws) and
 * blocks prototype-pollution keys.
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
  const query = nullObject();
  if (queryString) {
    const pairs = queryString.split("&");
    for (const pair of pairs) {
      if (!pair) continue;
      const eqIndex = pair.indexOf("=");
      let key: string;
      let value: string;
      if (eqIndex === -1) {
        key = safeDecode(pair);
        value = "";
      } else {
        key = safeDecode(pair.slice(0, eqIndex));
        value = safeDecode(pair.slice(eqIndex + 1));
      }
      if (isUnsafeKey(key)) continue;
      query[key] = value;
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
 *
 * Security: params object is prototype-free; forbidden keys are silently dropped.
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
      const params = nullObject();
      for (let i = 0; i < compiled.keys.length; i++) {
        const key = compiled.keys[i];
        if (isUnsafeKey(key)) continue;
        if (match[i + 1] !== undefined) {
          params[key] = safeDecode(match[i + 1]);
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
        params: nullObject(),
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
 *
 * Security: meta/link attribute names are validated against
 * `SAFE_ATTR_NAME`, URL attributes are routed through `sanitizeUrl`,
 * `title` is HTML-escaped, and the embedded state script escapes
 * `U+2028` / `U+2029` plus the usual `<`/`>`/`&` trio.
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
    nonce?: string;
  },
): string {
  const { html, state } = renderRouteToString(url, routes, options);
  const opts = options || {};

  // The SAME shared pipeline `renderToDocument` and `Head()` run: raw duplicate
  // case-insensitive names rejected first, then name filtering and value
  // sanitization, and only then the meta-refresh verdict — on the effective
  // snapshot, so what is validated is what is serialized.
  const metaTags = (opts.meta || [])
    .map((attrs) => serializeHeadEntry("meta", attrs))
    .filter(Boolean)
    .join("\n    ");

  const linkTags = (opts.links || [])
    .map((attrs) => serializeHeadEntry("link", attrs))
    .filter(Boolean)
    .join("\n    ");

  // Build script tags (external scripts) — `src` goes through the CANONICAL
  // sanitizer, not a local blocklist.
  const scriptTags = (opts.scripts || [])
    .map((src) => {
      const safe = sanitizeUrl(String(src));
      if (!safe) return "";
      return `<script src="${escapeAttrLocal(safe)}"></script>`;
    })
    .filter(Boolean)
    .join("\n    ");

  // Serialize route state for client pickup
  const stateScript = serializeRouteState(state, opts.nonce);

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${opts.title ? `<title>${escapeHtmlLocal(opts.title)}</title>` : ""}
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
 *
 * Security: escapes `<`/`>`/`&` and the ES line-terminator pairs
 * `U+2028` / `U+2029`. Supports an optional `nonce` attribute for
 * strict-CSP compatibility.
 */
export function serializeRouteState(state: SSRRouteState, nonce?: string): string {
  const json = escapeScriptJson(JSON.stringify(state));
  const nonceAttr = nonce ? ` nonce="${escapeAttrLocal(nonce)}"` : "";
  return `<script${nonceAttr}>window.${SSR_ROUTE_STATE_KEY}=${json}</script>`;
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

  // 2. Create the client router. Its constructor resolves the initial route
  //    from `window.location`, which on hydration matches the URL the server
  //    rendered (and therefore `serverState.path`). We intentionally do NOT
  //    issue an explicit navigate() to `serverState.path` here: a real
  //    navigation would re-render and discard the server-rendered DOM, which is
  //    exactly what hydration must avoid. If the address bar and
  //    `serverState.path` ever diverge (e.g. a server-side normalization), the
  //    location-driven resolution reconciles to the live URL.
  createRouter(routes as RouteDef[]);

  // 3. Hydrate the existing DOM — for the route the BROWSER is actually on.
  //
  // The server's path and the live URL can disagree: stale cached HTML, a CDN
  // serving another route's document, a proxy rewrite, or a redirect landing
  // elsewhere. Resolving from `serverState.path` here produced the one state
  // the bootstrap invariant forbids — location and router agreeing on /b while
  // the DOM showed /a (RM-001).
  //
  // Because SibuJS uses replacement hydration, rendering the live route costs
  // nothing extra: the server subtree is discarded either way. So the live URL
  // always wins, and DOM / router / location end up describing one location.
  const container = options?.container || document.getElementById("app");
  if (!container) return;

  // The live URL selects WHICH route to render. The navigation generation
  // decides WHETHER this bootstrap is still allowed to commit. Those are two
  // different questions and must not be conflated — see RM-002.
  const liveUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const resolved = resolveServerRoute(liveUrl, routes);
  const bootstrapEpoch = __getNavigationEpoch();

  import("../platform/ssr")
    .then(async ({ hydrate }) => {
      const { replaceChildrenSafely } = await import("../core/rendering/dispose");
      // Final ownership check, immediately before the commit that replaces the
      // container's DOM. Any navigation committed since bootstrap began has
      // advanced the generation, so this bootstrap is permanently superseded —
      // including the A→B→A case, where the URL is identical again but the
      // generation is not. Router teardown advances it too.
      if (__getNavigationEpoch() !== bootstrapEpoch) return;

      if (resolved.component) {
        hydrate(resolved.component, container);
        return;
      }
      // No route matched the live URL. Leaving the server's markup would show
      // content for a route the user is not on, so clear it instead.
      replaceChildrenSafely(container);
    })
    .catch((err) => {
      if (typeof console !== "undefined") {
        console.error("[SibuJS routerSSR] failed to load hydrate:", err);
      }
    });
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
      nonce?: string;
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
//
// What remains here is HTML text escaping, and nothing else. This block used to
// hold a private copy of the whole attribute policy — a name regex, an
// event-handler test, a URL-attribute set, and a `sanitizeUrlLocal` that
// BLOCKLISTED four schemes where the canonical sanitizer ALLOWLISTS five — under
// a comment promising it stayed "in sync with the master implementations". It
// did not: router SSR emitted `file:`, `about:`, `chrome:` and every custom
// scheme that `Head()` and `renderToDocument` both refused.
//
// A comment is not a mechanism. The policy now lives in `utils/headEntry.ts` and
// this module imports it.
// ============================================================================

function escapeHtmlLocal(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttrLocal(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
