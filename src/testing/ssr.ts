// ============================================================================
// SSR TESTING UTILITIES
// ============================================================================
//
//   const page = await renderOnServer(routes, { url: "/cotizar?servicio=dtf", router: { head } });
//   expect(page.status).toBe(200);
//   expect(page.text("h1")).toBe("Cotiza tu pedido");
//
//   const takeover = await hydrateInTest(page.html, () => Route(), { strategy: "adopt", state: page.state });
//   expect(takeover.created).toBe(0);
//   expect(takeover.mismatches).toEqual([]);

import type { AdoptMismatch, AdoptResult } from "../platform/hydrateAdopt";
import { type RenderRouteOptions, type RouteRenderResult, renderRoute } from "../platform/renderRoute";
import { hydrate } from "../platform/ssr";
import { type AsyncRenderOptions, type RenderResult, renderToStringAsync } from "../platform/ssrAsync";
import type { RouteDef } from "../plugins/router";
import { __resetTransfer } from "../utils/transfer";

/** Query helpers over rendered HTML, parsed into a detached element. */
export interface HtmlQueries {
  /** The parsed markup (a detached `<div>`). */
  container: HTMLElement;
  /** First element matching `selector`, or `null`. */
  query<E extends Element = HTMLElement>(selector: string): E | null;
  /** Every element matching `selector`. */
  queryAll<E extends Element = HTMLElement>(selector: string): E[];
  /** Trimmed `textContent` of the first match, or `null`. */
  text(selector: string): string | null;
  /** The first element whose own trimmed text is `text`. */
  getByText(text: string): HTMLElement | null;
  /** `content` of `<meta name|property="key">` in the head, or `null`. */
  meta(key: string): string | null;
  /** The head's `<title>` text, or `null`. */
  title(): string | null;
}

/** Result of {@link renderOnServer}. */
export type ServerRender = (RenderResult | RouteRenderResult) & HtmlQueries & { location: string | null };

/** Options of {@link renderOnServer}. */
export interface RenderOnServerOptions extends RenderRouteOptions {
  /** The URL to render when the first argument is a route table. Default `"/"`. */
  url?: string;
}

function parse(html: string): HTMLElement {
  if (typeof document === "undefined") {
    throw new Error(
      "[SibuJS testing] parsing server HTML needs a DOM with an HTML parser (run the test under jsdom or happy-dom)",
    );
  }
  const container = document.createElement("div");
  try {
    container.innerHTML = html;
  } catch (err) {
    throw new Error(
      "[SibuJS testing] the registered DOM cannot parse HTML (the SibuJS server DOM has no parser); run this test under jsdom or happy-dom",
      { cause: err },
    );
  }
  return container;
}

function queriesFor(html: string, head: string): HtmlQueries {
  const container = parse(html);
  const headEl = parse(head);
  return {
    container,
    query: (selector) => container.querySelector(selector),
    queryAll: (selector) => Array.from(container.querySelectorAll(selector)),
    text: (selector) => container.querySelector(selector)?.textContent?.trim() ?? null,
    getByText: (text) => {
      for (const el of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
        let own = "";
        for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) own += n.textContent;
        if (own.trim() === text) return el;
      }
      return null;
    },
    meta: (key) =>
      headEl.querySelector(`meta[name="${key}"], meta[property="${key}"]`)?.getAttribute("content") ??
      container.querySelector(`meta[name="${key}"], meta[property="${key}"]`)?.getAttribute("content") ??
      null,
    title: () => headEl.querySelector("title")?.textContent ?? container.querySelector("title")?.textContent ?? null,
  };
}

/**
 * Render on the server, as a test sees it: a route table through the router
 * (`renderRoute`, with HTTP status and redirects) or a component
 * (`renderToStringAsync`), awaited until settled, plus query helpers over the
 * resulting HTML and head.
 *
 * @param app A route table, or a function building the page.
 * @param options `url` for a route table, plus any `renderRoute` option.
 * @returns `{ html, head, status, state, stateData, location, diagnostics }` and the query helpers.
 */
export async function renderOnServer(
  app: RouteDef[] | (() => Node),
  options: RenderOnServerOptions = {},
): Promise<ServerRender> {
  const { url = "/", ...rest } = options;
  const result: RenderResult | RouteRenderResult = Array.isArray(app)
    ? await renderRoute(app, url, rest)
    : await renderToStringAsync(app, rest as AsyncRenderOptions);
  const location = "location" in result ? (result as RouteRenderResult).location : null;
  return { ...result, location, ...queriesFor(result.html, result.head) };
}

/** Options of {@link hydrateInTest}. */
export interface HydrateInTestOptions {
  /** `"replace"` (the default `hydrate()`) or `"adopt"`. */
  strategy?: "replace" | "adopt";
  /** The server's transfer script (`result.state`): run first, as the browser would. */
  state?: string;
  /** Mount the container in `document.body` (default `true`; adoption of focus/scroll needs it). */
  attach?: boolean;
}

/** Result of {@link hydrateInTest}. */
export interface HydrationReport {
  /** The container holding the hydrated page. */
  container: HTMLElement;
  /** Elements created by the hydration that ended up in the page (0 for a perfect adoption). */
  created: number;
  /** Elements the adoption reused (adopt only; 0 for replace). */
  adopted: number;
  /** Divergences the adoption found (adopt only). */
  mismatches: AdoptMismatch[];
  /** The full adoption result (adopt only). */
  result: AdoptResult | null;
  /** Remove the container. */
  cleanup(): void;
}

/**
 * Take over server HTML in a test: put it in a container, restore the
 * transferred state, hydrate, and report what happened — how many elements
 * were created (by spying on `createElement` / `createElementNS` while the
 * hydration runs) and, for adoption, the mismatches.
 *
 * @param html The server markup (`result.html`).
 * @param app The same root the server rendered.
 * @param options Strategy, transfer script, attachment.
 * @returns Counts, mismatches, the container and a cleanup.
 */
export async function hydrateInTest(
  html: string,
  app: () => Node,
  options: HydrateInTestOptions = {},
): Promise<HydrationReport> {
  const container = document.createElement("div");
  container.innerHTML = html;
  if (options.attach !== false) document.body.appendChild(container);

  if (options.state) {
    const body = /<script[^>]*>([\s\S]*)<\/script>/.exec(options.state)?.[1];
    // Test-only: this is the framework's own escaped payload, run as the page would.
    if (body) new Function(body)();
    __resetTransfer();
  }

  const created: Element[] = [];
  const doc = document as Document & Record<string, unknown>;
  const createElement = doc.createElement;
  const createElementNS = doc.createElementNS;
  doc.createElement = function (this: Document, ...args: Parameters<Document["createElement"]>) {
    const el = createElement.apply(this, args);
    created.push(el);
    return el;
  } as Document["createElement"];
  doc.createElementNS = function (this: Document, ...args: [string | null, string]) {
    const el = (createElementNS as (ns: string | null, q: string) => Element).apply(this, args);
    created.push(el);
    return el;
  } as Document["createElementNS"];

  let result: AdoptResult | null = null;
  try {
    if (options.strategy === "adopt") {
      result = await hydrate(app, container, { strategy: "adopt" });
    } else {
      hydrate(app as () => HTMLElement, container);
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    doc.createElement = createElement;
    doc.createElementNS = createElementNS;
  }

  return {
    container,
    created: created.filter((el) => container.contains(el)).length,
    adopted: result?.adopted ?? 0,
    mismatches: result?.mismatches ?? [],
    result,
    cleanup: () => container.remove(),
  };
}
