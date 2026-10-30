// ============================================================================
// RENDER A URL THROUGH THE ROUTER
// ============================================================================
//
// `renderRoute(routes, url)` is a server render of one request: it creates a
// memory router for `url` inside a fresh request scope (so concurrent renders
// each have their own router, query cache, ids and head), lets the router run
// its guards, `beforeEnter`, redirects and lazy loads exactly as in a browser,
// then renders `Route()` (or your app shell) once everything has settled.
//
// The result carries the HTTP status a server should answer with:
//
//   200  the route rendered
//   404  the match is the `*` route (or a record declares `status: 404`)
//   301/302 + `location`  a redirect (no body is rendered)
//   403 (configurable)    a guard rejected the navigation (no body)
//   500  the navigation failed for another reason (no body)

import { runInSSRContext } from "../core/ssr-context";
import { createRouter, route as currentRoute, Route, type RouteDef, type RouterOptions } from "../plugins/router";
import { collectServerHead } from "./serverHead";
import { assembleDocument, type DocumentOptions } from "./ssr";
import { type AsyncRenderOptions, type RenderResult, renderToStringAsync } from "./ssrAsync";

/** How a route is treated by server renders (see `RouteBase.render`); `"default"` when no record declares one. */
export type RouteRenderMode = "ssr" | "prerender" | "client" | "default";

/** Options of {@link renderRoute}. */
export interface RenderRouteOptions extends AsyncRenderOptions {
  /**
   * Builds the page around the routed content. Default: `() => Route()`.
   * Use your app shell (`() => App()`) when it contains the outlet.
   */
  app?: () => Node;
  /** Router options (`head`, `base`, `guardTimeout`, …). `mode` and `url` are set by `renderRoute`. */
  router?: Omit<RouterOptions, "mode" | "url">;
  /** Status for a navigation a guard rejected. Default 403. Redirect from the guard for a login page (302). */
  rejectStatus?: number;
  /**
   * Wrap the body in a full document (`renderToDocument`'s), with the
   * collected head tags in `<head>` and the transfer script in `<body>`.
   */
  document?: DocumentOptions;
}

/** The routed part of a {@link renderRoute} result. */
export interface RenderedRoute {
  /** The committed path (after redirects). */
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  hash: string;
  /** `name` of the deepest matched record, if it has one. */
  name: string | null;
}

/** Result of {@link renderRoute}. */
export interface RouteRenderResult extends RenderResult {
  /** `Location` header value for a redirect, else `null`. */
  location: string | null;
  /** The committed route, or `null` when the navigation was rejected or failed. */
  route: RenderedRoute | null;
  /** The route's rendering mode; for `"client"` the body is empty (shell plus head). */
  render: RouteRenderMode;
  /** True when the route's head declares `robots: noindex` (left out of a sitemap). */
  noindex: boolean;
  /** Why the navigation did not commit (`"guard"`, `"redirect-loop"`, …), else `null`. */
  failure: string | null;
}

function deepest<K extends "status" | "render">(matched: readonly RouteDef[], key: K): RouteDef[K] | undefined {
  for (let i = matched.length - 1; i >= 0; i--) {
    const value = matched[i][key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function emptyDiagnostics(): RenderResult["diagnostics"] {
  return {
    timedOut: false,
    pending: [],
    browserApis: [],
    stateBytes: 0,
    largestState: [],
    droppedState: [],
    durationMs: 0,
  };
}

/**
 * Render one URL through the router, in its own request scope.
 *
 * @param routes The app's route table (the same one the browser uses).
 * @param url The request URL path with query and hash (`"/cotizar?servicio=dtf"`).
 * @param options App shell, router options, settle timeout, state transfer, document.
 * @returns HTML, head, transfer state, HTTP status, redirect location, route, diagnostics.
 *
 * @example
 * ```ts
 * const r = await renderRoute(routes, req.url, { router: { head }, document: { scripts: ["/assets/main.js"] } });
 * if (r.location) return res.redirect(r.status, r.location);
 * res.status(r.status).send(r.html);
 * ```
 */
export function renderRoute(
  routes: RouteDef[],
  url: string,
  options: RenderRouteOptions = {},
): Promise<RouteRenderResult> {
  return runInSSRContext(async (): Promise<RouteRenderResult> => {
    const started = Date.now();
    const router = createRouter(routes, { ...options.router, mode: "memory", url });
    try {
      await router.whenReady();
      const { result, redirectStatus } = router.initialOutcome;
      const committed = currentRoute();
      const matched = committed.matched;
      const base = options.router?.base ?? "";
      const head = () => collectServerHead();
      const wrap = (body: string, headHtml: string, state: string) =>
        options.document ? assembleDocument(body, options.document, headHtml, state) : body;

      if (result && !result.success) {
        const reason = result.reason ?? "error";
        const status = reason === "guard" ? (options.rejectStatus ?? 403) : 500;
        const headHtml = head();
        return {
          html: wrap("", headHtml, ""),
          head: headHtml,
          state: "",
          stateData: null,
          status,
          location: null,
          route: null,
          render: "default",
          noindex: false,
          failure: reason,
          diagnostics: { ...emptyDiagnostics(), durationMs: Date.now() - started },
        };
      }

      const search = new URLSearchParams();
      for (const [key, values] of Object.entries(committed.queryAll)) for (const v of values) search.append(key, v);
      const fullPath =
        committed.path + (search.size > 0 ? `?${search}` : "") + (committed.hash ? `#${committed.hash}` : "");
      const routeInfo: RenderedRoute = {
        path: committed.path,
        params: { ...committed.params },
        query: { ...committed.query },
        hash: committed.hash,
        name: matched.length > 0 ? (matched[matched.length - 1].name ?? null) : null,
      };
      const headHtml0 = head();
      const noindex = /<meta name="robots" content="[^"]*noindex/i.test(headHtml0);

      if (redirectStatus !== null) {
        return {
          html: "",
          head: headHtml0,
          state: "",
          stateData: null,
          status: redirectStatus,
          location: base + fullPath,
          route: routeInfo,
          render: "default",
          noindex,
          failure: null,
          diagnostics: { ...emptyDiagnostics(), durationMs: Date.now() - started },
        };
      }

      const leaf = matched[matched.length - 1];
      const status = deepest(matched, "status") ?? (!leaf || leaf.path === "*" ? 404 : 200);
      const render: RouteRenderMode = deepest(matched, "render") ?? "default";

      if (render === "client") {
        return {
          html: wrap("", headHtml0, ""),
          head: headHtml0,
          state: "",
          stateData: null,
          status,
          location: null,
          route: routeInfo,
          render,
          noindex,
          failure: null,
          diagnostics: { ...emptyDiagnostics(), durationMs: Date.now() - started },
        };
      }

      const rendered = await renderToStringAsync(options.app ?? (() => Route()), options);
      return {
        ...rendered,
        html: wrap(rendered.html, rendered.head, rendered.state),
        status,
        location: null,
        route: routeInfo,
        render,
        noindex: /<meta name="robots" content="[^"]*noindex/i.test(rendered.head),
        failure: null,
      };
    } finally {
      router.destroy();
    }
  });
}
