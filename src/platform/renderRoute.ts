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
//   503  the deadline passed before the route could render (no body,
//        `failure: "timeout"`, `diagnostics.timedOut`)
//
// `timeout` is ONE deadline for the whole request: the initial navigation
// (guards included), loading the matched components, then building and
// settling the page, which gets whatever budget is left. The components are
// loaded only for a response with a body: a redirect, a failed navigation, a
// `render: "client"` route and a `headOnly` mode answer from the navigation
// outcome and the route records, without importing anything.

import { DEV } from "../core/dev";
import { assertRequestIsolation, getRequestStore, runInSSRContext } from "../core/ssr-context";
import { createRouter, route as currentRoute, Route, type RouteDef, type RouterOptions } from "../plugins/router";
import { collectServerHead } from "./serverHead";
import { assembleDocument, type DocumentOptions } from "./ssr";
import { type AsyncRenderOptions, DEFAULT_SETTLE_TIMEOUT, type RenderResult, renderToStringAsync } from "./ssrAsync";

/** How a route is treated by server renders (see `RouteBase.render`); `"default"` when no record declares one. */
export type RouteRenderMode = "ssr" | "prerender" | "client" | "default";

/** Options of {@link renderRoute}. */
export interface RenderRouteOptions extends AsyncRenderOptions {
  /**
   * Milliseconds for the whole request (default 5000): the initial navigation,
   * the matched components' loads, then building and settling the page. Past
   * it before the route rendered, the result is a 503 with `failure:
   * "timeout"`; past it while the page settles, what is ready is serialized
   * with fallbacks (`diagnostics.timedOut`), as `renderToStringAsync` does.
   */
  timeout?: number;
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
  /**
   * Render modes answered with the head alone, as `"client"` always is: the
   * route is matched, guarded and redirected as usual, and its `head` is
   * resolved from the route records, but no component (the route's or
   * `app`'s) is built, so nothing it would fetch runs and nothing transfers.
   * The pre-renderer passes `["ssr"]`: a per-request page ships as the shell
   * plus its route head, without rendering it at build time.
   * @internal
   */
  headOnly?: readonly RouteRenderMode[];
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
  /**
   * Who answered with the redirect: a `redirect` record (`"route"`, the same
   * for every visitor) or a guard (`"guard"`, it depends on the visitor).
   */
  redirectBy: "route" | "guard" | null;
}

function deepest<K extends "status" | "render">(matched: readonly RouteDef[], key: K): RouteDef[K] | undefined {
  for (let i = matched.length - 1; i >= 0; i--) {
    const value = matched[i][key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Percent-encode what may not appear raw in a URL path or fragment — control
 * characters, spaces, non-ASCII, a `%` that starts no escape — and keep what
 * may (existing `%XX` escapes included), so an already encoded path is
 * unchanged. A lone surrogate becomes U+FFFD.
 */
function encodeUrlPart(part: string): string {
  return part.replace(/%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~!$&'()*+,;=:@/?%]/gu, (c) => {
    try {
      return encodeURIComponent(c);
    } catch {
      return "%EF%BF%BD";
    }
  });
}

/**
 * Wait for `work` until `deadline`: `true` when it settled first (fulfilled or
 * rejected), `false` when the deadline came first. A late settlement is
 * observed and ignored, never left as an unhandled rejection.
 */
function before(work: Promise<unknown>, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    work.then(done, done);
  });
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
  try {
    assertRequestIsolation("renderRoute()");
  } catch (err) {
    return Promise.reject(err);
  }
  return runInSSRContext(async (): Promise<RouteRenderResult> => {
    const started = Date.now();
    // One deadline for the whole request, set before the navigation starts.
    const deadline = started + (options.timeout ?? DEFAULT_SETTLE_TIMEOUT);
    const router = createRouter(routes, { ...options.router, mode: "memory", url });
    const wrap = (body: string, headHtml: string, state: string) =>
      options.document ? assembleDocument(body, options.document, headHtml, state) : body;

    // The deadline passed before the route could render: answer 503 with what
    // was still running. The router is destroyed in `finally`, so a navigation
    // or component load finishing later commits nothing; a dynamic import
    // cannot be cancelled, its late result is ignored.
    const timedOut = (phase: string): RouteRenderResult => {
      const now = Date.now();
      const pending = [
        `${phase} (${now - started} ms)`,
        ...Array.from(getRequestStore()?.pending ?? [], (work) => `${work.label} (${now - work.since} ms)`),
      ];
      const diagnostics = { ...emptyDiagnostics(), timedOut: true, pending, durationMs: now - started };
      if (DEV) {
        console.warn(
          `[SibuJS SSR] ${url}: the route did not render within ${options.timeout ?? DEFAULT_SETTLE_TIMEOUT} ms; pending: ${pending.join(", ")}`,
        );
      }
      return {
        html: wrap("", "", ""),
        head: "",
        state: "",
        stateData: null,
        status: 503,
        location: null,
        route: null,
        render: "default",
        noindex: false,
        failure: "timeout",
        redirectBy: null,
        diagnostics,
      };
    };

    try {
      // Navigation first (guards, redirects): the outcome and the matched
      // records decide the response. The matched components are loaded only
      // for a response with a body, further down — a redirect, a failed
      // navigation or a head-only page never imports them.
      if (!(await before(router.whenNavigated(), deadline))) return timedOut("route:navigation");
      const { result, redirectStatus, redirectBy } = router.initialOutcome;
      const committed = currentRoute();
      const matched = committed.matched;
      const base = options.router?.base ?? "";
      const head = () => collectServerHead();

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
          redirectBy: null,
          diagnostics: { ...emptyDiagnostics(), durationMs: Date.now() - started },
        };
      }

      const search = new URLSearchParams();
      for (const [key, values] of Object.entries(committed.queryAll)) for (const v of values) search.append(key, v);
      // The Location header value: a redirect target built from decoded params
      // can hold CR/LF or non-Latin-1 text, which a `Headers` object refuses
      // (and an HTTP server would have to reject).
      const locationPath =
        encodeUrlPart(committed.path) +
        (search.size > 0 ? `?${search}` : "") +
        (committed.hash ? `#${encodeUrlPart(committed.hash)}` : "");
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
          location: encodeUrlPart(base) + locationPath,
          route: routeInfo,
          render: "default",
          noindex,
          failure: null,
          redirectBy,
          diagnostics: { ...emptyDiagnostics(), durationMs: Date.now() - started },
        };
      }

      const leaf = matched[matched.length - 1];
      const status = deepest(matched, "status") ?? (!leaf || leaf.path === "*" ? 404 : 200);
      const render: RouteRenderMode = deepest(matched, "render") ?? "default";

      if (render === "client" || options.headOnly?.includes(render)) {
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
          redirectBy: null,
          diagnostics: { ...emptyDiagnostics(), durationMs: Date.now() - started },
        };
      }

      // A body: load the matched components, then build and settle the page,
      // each with what is left of the deadline.
      if (!(await before(router.whenReady(), deadline))) return timedOut("route:components");
      const rendered = await renderToStringAsync(options.app ?? (() => Route()), {
        ...options,
        timeout: Math.max(0, deadline - Date.now()),
        log: options.log === true ? url : options.log,
      });
      return {
        ...rendered,
        html: wrap(rendered.html, rendered.head, rendered.state),
        status,
        location: null,
        route: routeInfo,
        render,
        noindex: /<meta name="robots" content="[^"]*noindex/i.test(rendered.head),
        failure: null,
        redirectBy: null,
      };
    } finally {
      router.destroy();
    }
  });
}
