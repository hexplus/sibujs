// ============================================================================
// A RENDER HANDLER FOR A NODE SIDECAR
// ============================================================================
//
// `createRenderHandler(routes, options)` wraps `renderRoute` as a standard
// `(request: Request) => Promise<Response>` handler: the shape Node's
// `http` (with a 10-line adapter), Hono, Deno and edge runtimes all speak. A
// Python / Go / PHP backend proxies its HTML routes to it, or calls it and
// relays the response.
//
// Status and `Location` come from the router (see `renderRoute`). Caching:
// every response gets a `Cache-Control` header (overridable), and an optional
// in-memory cache keeps rendered pages keyed by URL plus a data version — bump
// the version when the data changes (an admin webhook) and every page renders
// again on its next request.

import type { RouteDef } from "../plugins/router";
import { type RenderRouteOptions, type RouteRenderResult, renderRoute } from "./renderRoute";

/** Options of {@link createRenderHandler}. */
export interface RenderHandlerOptions extends RenderRouteOptions {
  /**
   * Keep rendered pages in memory. `max` entries (default 500), each for `ttl`
   * ms (default 60 000); `version()` is part of the key, so changing what it
   * returns makes every cached page stale at once. The cache also holds at
   * most `maxBytes` of HTML (default 32 MB): any query string is a distinct
   * key, so a client inventing them evicts the oldest pages but cannot grow the
   * process without bound.
   *
   * A page is stored only when it is a 200 or 404 that did not time out AND
   * its `Cache-Control` (from `cacheControl`) allows a shared cache: no
   * `no-store`, `no-cache` or `private` directive. This cache is shared by
   * every visitor, so a personalized page must say `private` (or `no-store`)
   * — that is the opt-out, and the default 404 (`no-store`) is not stored
   * either. `x-sibu-cache` says what happened: `hit`, `miss` (rendered and
   * stored) or `bypass` (rendered, not stored).
   */
  cache?: { max?: number; ttl?: number; maxBytes?: number; version?: () => string | number };
  /**
   * The `Cache-Control` value for a result. Default: 200 →
   * `public, max-age=0, s-maxage=60, stale-while-revalidate=600`; 301/308 →
   * `public, max-age=3600`; a timed-out render and anything else → `no-store`.
   * Return `null` to send none.
   */
  cacheControl?: (result: RouteRenderResult) => string | null;
}

/** A cached page. */
interface Entry {
  status: number;
  html: string;
  control: string | null;
  expires: number;
  bytes: number;
}

const encoder = new TextEncoder();

/**
 * Whether a `Cache-Control` value lets the handler's SHARED page cache keep
 * the response. Directives are parsed (comma-separated, names
 * case-insensitive, `private="set-cookie"` counts as `private`), not
 * substring-matched; no header at all leaves the page cacheable.
 */
function sharedCacheable(control: string | null): boolean {
  if (!control) return true;
  for (const part of control.split(",")) {
    const name = part.split("=")[0].trim().toLowerCase();
    if (name === "no-store" || name === "no-cache" || name === "private") return false;
  }
  return true;
}

function defaultCacheControl(result: RouteRenderResult): string {
  // A page serialized with fallbacks because its data did not arrive in time
  // is this request's answer only, never one for a shared cache.
  if (result.diagnostics.timedOut) return "no-store";
  if (result.status === 200) return "public, max-age=0, s-maxage=60, stale-while-revalidate=600";
  if (result.status === 301 || result.status === 308) return "public, max-age=3600";
  return "no-store";
}

/**
 * Serve server-rendered pages from a route table.
 *
 * @param routes The app's route table.
 * @param options `renderRoute` options (a `document` is used by default, so the
 * response is a full page), plus `cache` and `cacheControl`.
 * @returns A `Request → Response` handler. GET and HEAD only (others: 405). A
 * render that throws answers a bare 500 (`no-store`, no error details) and is
 * logged with `console.error`; the handler itself never rejects.
 *
 * @example
 * ```ts
 * const handle = createRenderHandler(routes, {
 *   router: { head },
 *   document: { scripts: ["/assets/main.js"] },
 *   cache: { version: () => catalogVersion },
 * });
 * ```
 */
export function createRenderHandler(
  routes: RouteDef[],
  options: RenderHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const { cache, cacheControl = defaultCacheControl, ...renderOptions } = options;
  const document = renderOptions.document ?? {};
  const store = cache ? new Map<string, Entry>() : null;
  const max = cache?.max ?? 500;
  const ttl = cache?.ttl ?? 60_000;
  const maxBytes = cache?.maxBytes ?? 32 * 1024 * 1024;
  let cachedBytes = 0;
  const evict = (key: string) => {
    const entry = store?.get(key);
    if (!entry) return;
    store?.delete(key);
    cachedBytes -= entry.bytes;
  };

  const respond = (status: number, html: string, head: boolean, headers: Record<string, string>) =>
    new Response(head || status === 204 || (status >= 300 && status < 400) ? null : html, {
      status,
      headers: { "content-type": "text/html; charset=utf-8", ...headers },
    });

  return async (request: Request): Promise<Response> => {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    const key = store ? `${cache?.version?.() ?? ""}\u0000${path}` : "";
    const head = method === "HEAD";

    if (store) {
      const hit = store.get(key);
      if (hit && hit.expires > Date.now()) {
        // Refresh recency for the LRU order.
        store.delete(key);
        store.set(key, hit);
        const hitHeaders: Record<string, string> = { "x-sibu-cache": "hit" };
        if (hit.control) hitHeaders["cache-control"] = hit.control;
        return respond(hit.status, hit.html, head, hitHeaders);
      }
      if (hit) evict(key);
    }

    let result: RouteRenderResult;
    try {
      result = await renderRoute(routes, path, { ...renderOptions, document });
    } catch (err) {
      // The error stays in the server log; the visitor gets no stack or message.
      console.error(`[SibuJS SSR] render of ${path} failed:`, err);
      return new Response(head ? null : "Internal Server Error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const headers: Record<string, string> = {};
    const control = cacheControl(result);
    if (control) headers["cache-control"] = control;
    if (result.location) headers.location = result.location;

    if (store) {
      const eligible =
        (result.status === 200 || result.status === 404) && !result.diagnostics.timedOut && sharedCacheable(control);
      const bytes = eligible ? encoder.encode(result.html).byteLength : 0;
      if (eligible && bytes <= maxBytes) {
        evict(key);
        store.set(key, { status: result.status, html: result.html, control, expires: Date.now() + ttl, bytes });
        cachedBytes += bytes;
        while (store.size > max || cachedBytes > maxBytes) evict(store.keys().next().value as string);
        headers["x-sibu-cache"] = "miss";
      } else {
        headers["x-sibu-cache"] = "bypass";
      }
    }
    return respond(result.status, result.html, head, headers);
  };
}
