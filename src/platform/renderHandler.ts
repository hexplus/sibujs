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
   * returns makes every cached page stale at once. Only 200 and 404 pages are
   * cached; redirects and errors always render.
   */
  cache?: { max?: number; ttl?: number; version?: () => string | number };
  /**
   * The `Cache-Control` value for a result. Default: 200 →
   * `public, max-age=0, s-maxage=60, stale-while-revalidate=600`; 301/308 →
   * `public, max-age=3600`; anything else → `no-store`. Return `null` to send none.
   */
  cacheControl?: (result: RouteRenderResult) => string | null;
}

/** A cached page. */
interface Entry {
  status: number;
  html: string;
  control: string | null;
  expires: number;
}

function defaultCacheControl(result: RouteRenderResult): string {
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
 * @returns A `Request → Response` handler. GET and HEAD only (others: 405).
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
      if (hit) store.delete(key);
    }

    const result = await renderRoute(routes, path, { ...renderOptions, document });
    const headers: Record<string, string> = {};
    const control = cacheControl(result);
    if (control) headers["cache-control"] = control;
    if (result.location) headers.location = result.location;

    if (store && (result.status === 200 || result.status === 404)) {
      store.set(key, { status: result.status, html: result.html, control, expires: Date.now() + ttl });
      while (store.size > max) store.delete(store.keys().next().value as string);
      headers["x-sibu-cache"] = "miss";
    }
    return respond(result.status, result.html, head, headers);
  };
}
