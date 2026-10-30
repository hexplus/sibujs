/**
 * Pre-rendering from a SERVER ENTRY: `sibuVitePlugin({ prerender: { server } })`.
 *
 * The 4.13 pre-renderer runs the app's client entry in a jsdom worker per
 * route. This mode instead renders each route with `renderRoute()` — the
 * request-scoped router, the async settle, the collected head and the
 * transferred state — on the built-in server DOM, in one Node process with no
 * DOM library:
 *
 *  1. The server entry (it exports the app's `routes`, and optionally `head`,
 *     `app`, `routerOptions`) is built for Node by Vite, with the app's own
 *     config, together with a small driver that imports `renderRoute` from
 *     `sibujs/ssr` — so the driver and the app share one copy of SibuJS.
 *  2. The route list is expanded: static routes, plus every path a dynamic
 *     route's `getStaticPaths()` returns.
 *  3. Each URL is rendered; the body goes into the built shell's `#app`, the
 *     head tags replace the shell's `<title>`, the transfer script goes before
 *     `</body>`. Redirects are listed (a static server cannot answer 301), the
 *     `*` route becomes `404.html`, a `render: "client"` route is the shell
 *     plus its head.
 *  4. `sitemap.xml` (and `robots.txt` on request) are written.
 */

import type { PrerenderBuildContext, PrerenderOptions, PrerenderResult, PrerenderRoute } from "./prerender";

/** What the server entry module exports. */
export interface PrerenderServerEntry {
  /** The app's route table — the one the browser uses. */
  routes: unknown[];
  /** Router head defaults (`createRouter({ head })`). */
  head?: unknown;
  /** Other router options (`base`, `guardTimeout`…). */
  routerOptions?: Record<string, unknown>;
  /** The page around the routed content. Default: `Route()`. */
  app?: () => unknown;
}

interface DriverModule {
  renderRoute: (routes: unknown[], url: string, options: Record<string, unknown>) => Promise<RouteResultLike>;
  entry: PrerenderServerEntry;
}

interface RouteResultLike {
  html: string;
  head: string;
  state: string;
  status: number;
  location: string | null;
  render: string;
  noindex: boolean;
  failure: string | null;
  redirectBy?: "route" | "guard" | null;
  diagnostics: { timedOut: boolean; pending: string[]; browserApis: string[] };
}

interface RouteRecordLike {
  path: string;
  children?: RouteRecordLike[];
  redirect?: unknown;
  render?: string;
  getStaticPaths?: () => Iterable<Record<string, string> | string> | Promise<Iterable<Record<string, string> | string>>;
}

const DRIVER_ID = "virtual:sibu-prerender-driver";
const DRIVER_RESOLVED = `\0${DRIVER_ID}`;

function joinPath(parent: string, child: string): string {
  if (child === "*" || child.startsWith("/*")) return child;
  const p = parent.replace(/\/+$/, "");
  const c = child.startsWith("/") ? child : `/${child}`;
  return (p + c).replace(/\/{2,}/g, "/") || "/";
}

/**
 * The URLs to render for a route table: every path without params, plus the
 * paths each dynamic record's `getStaticPaths()` lists. Redirects, `*` and
 * param paths without `getStaticPaths` are skipped (a dynamic route with no
 * list cannot be rendered statically).
 * @internal
 */
export async function expandRoutes(routes: readonly unknown[]): Promise<string[]> {
  const out: string[] = [];
  const visit = async (records: readonly RouteRecordLike[], parent: string) => {
    for (const record of records) {
      if (!record || typeof record.path !== "string") continue;
      const full = parent ? joinPath(parent, record.path) : record.path;
      if (record.children?.length) await visit(record.children, full);
      if (full.includes("*")) continue;
      // A redirect is listed (it lands in redirects.json) unless it has params.
      if ("redirect" in record && record.redirect !== undefined) {
        if (!/:/.test(full)) out.push(full);
        continue;
      }
      if (/:/.test(full)) {
        if (typeof record.getStaticPaths !== "function") continue;
        let entries: Iterable<Record<string, string> | string>;
        try {
          entries = await record.getStaticPaths();
        } catch (err) {
          throw new Error(
            `[sibu prerender] getStaticPaths() of "${full}" failed: ${err instanceof Error ? err.message : String(err)}. ` +
              "If it reads an API, start it and point `prerender.fetch` at it.",
            { cause: err },
          );
        }
        for (const entry of entries) {
          if (typeof entry === "string") {
            out.push(entry);
            continue;
          }
          let path = full;
          for (const [key, value] of Object.entries(entry)) {
            path = path.replace(new RegExp(`:${key}(?=[/?#]|$)`, "g"), encodeURIComponent(String(value)));
          }
          if (/:[A-Za-z_]/.test(path)) {
            throw new Error(
              `[sibu prerender] getStaticPaths() of "${full}" returned ${JSON.stringify(entry)}, which leaves a param unset`,
            );
          }
          out.push(path);
        }
        continue;
      }
      // A layout with children renders through its children's paths.
      if (record.children?.length) continue;
      out.push(full);
    }
  };
  await visit(routes as RouteRecordLike[], "");
  return Array.from(new Set(out));
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** The text of a `<title>` (RCDATA): its character references decoded. */
function decodeTitleText(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (ref: string, body: string) => {
    if (body[0] !== "#") return named[body.toLowerCase()] ?? ref;
    const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ref;
  });
}

/**
 * Put a rendered route into the built shell: the body inside the element with
 * id `container`, the head tags before `</head>` (replacing the shell's
 * `<title>` when the route has one, which keeps the shell's title in
 * `data-sibu-base-title` for the client router), the transfer script before
 * `</body>`.
 *
 * Every insertion is a replacement CALLBACK: a string replacement would read
 * `$&`, `$'`, `` $` ``, `$$` and `$1` in a page title or in transferred JSON as
 * replacement patterns and splice parts of the shell into the page.
 * @internal
 */
export function injectIntoShell(
  shell: string,
  parts: { body: string; head: string; state: string },
  container = "app",
): string {
  let html = shell;
  const shellTitle = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  if (parts.head) {
    let head = parts.head;
    if (/<title>/i.test(head)) {
      html = html.replace(/\s*<title>[\s\S]*?<\/title>/i, () => "");
      // The attribute carries the title TEXT (what `document.title` reads), so
      // the shell's character references are decoded before it is escaped.
      const baseTitle = `<title data-sibu-base-title="${escapeAttr(decodeTitleText(shellTitle))}">`;
      head = head.replace(/<title>/i, () => baseTitle);
    }
    const headHtml = head;
    html = html.replace(/<\/head>/i, () => `    ${headHtml}\n  </head>`);
  }
  if (parts.body) {
    const id = container.replace(/[^A-Za-z0-9_-]/g, "");
    const open = new RegExp(`(<([a-z][a-z0-9-]*)\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>)([\\s\\S]*?)(</\\2>)`, "i");
    if (!open.test(html))
      throw new Error(`[sibu prerender] the built index.html has no element with id="${id}" to render into`);
    html = html.replace(
      open,
      (_m, openTag: string, _tag: string, _inner: string, close: string) => `${openTag}${parts.body}${close}`,
    );
  }
  if (parts.state) html = html.replace(/<\/body>/i, () => `  ${parts.state}\n  </body>`);
  return html;
}

/**
 * Fail the build, naming the route, when a page cannot be written as rendered:
 * an API request that never reached the API, a route that did not render
 * before the deadline (a lazy import, a guard or a route load that never
 * finished), or a page that did not settle.
 * @internal
 */
export function assertPrerendered(
  url: string,
  result: {
    failure: string | null;
    diagnostics: { timedOut: boolean; pending: string[] };
  },
  failures: readonly string[],
  timeout: number,
): void {
  if (failures.length > 0) {
    throw new Error(
      `[sibu prerender] ${url}: ${failures[0]}. The page needs data from an API that is not reachable ` +
        "at build time — start it and point `prerender.fetch` at it, or skip the request with isPrerendering().",
    );
  }
  const pending = result.diagnostics.pending.join(", ");
  if (result.failure === "timeout") {
    throw new Error(
      `[sibu prerender] ${url}: the route did not render within ${timeout} ms (pending: ${pending}). ` +
        "A lazy import, a guard or a route load did not finish in time; fix it or raise `prerender.timeout`.",
    );
  }
  if (result.diagnostics.timedOut) {
    throw new Error(`[sibu prerender] ${url}: did not settle within ${timeout} ms (pending: ${pending})`);
  }
}

/** `sitemap.xml` for the indexable pages. @internal */
export function buildSitemap(origin: string, paths: readonly string[]): string {
  const urls = paths.map((p) => `  <url><loc>${escapeXml(origin + p)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/**
 * Pre-render from a server entry. See the module comment.
 * @internal — reached through `prerender()` when `options.server` is set.
 */
export async function prerenderFromServerEntry(
  options: PrerenderOptions,
  ctx: PrerenderBuildContext,
  helpers: {
    outputFileFor: (route: PrerenderRoute, trailingSlash?: "always" | "never") => string;
    resolveInsideOutDir: (path: typeof import("node:path"), outDir: string, file: string) => string;
    loadViteBuild: () => Promise<(config: Record<string, unknown>) => Promise<unknown>>;
    childEnv: string;
  },
): Promise<PrerenderResult[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { AsyncLocalStorage } = await import("node:async_hooks");

  const outDir = options.outDir ? path.resolve(ctx.root, options.outDir) : ctx.outDir;
  const origin = (options.origin ?? "http://localhost").replace(/\/+$/, "");
  const serverEntry = path.resolve(ctx.root, String(options.server).replace(/^\//, ""));
  // A re-run (`sibujs prerender`) finds `index.html` already rendered; the
  // untouched shell kept from the first run is the template then.
  const keptShell = path.join(ctx.outDir, typeof options.shell === "string" ? options.shell : "200.html");
  const shellPath = await fs
    .access(keptShell)
    .then(() => keptShell)
    .catch(() => path.join(ctx.outDir, "index.html"));
  const shell = await fs.readFile(shellPath, "utf8");
  // A fresh directory per run: Node caches ES modules by URL, so a second build
  // in the same process must not import the previous run's driver.
  const tmpDir = path.join(
    outDir,
    `.sibu-prerender-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.rm(tmpDir, { recursive: true, force: true });

  // 1 — the server entry plus the driver, built for Node with the app's config.
  const viteBuild = await helpers.loadViteBuild();
  const driverSource =
    `import { renderRoute } from "sibujs/ssr";\n` +
    `import * as entry from ${JSON.stringify(serverEntry.split(path.sep).join("/"))};\n` +
    "export { renderRoute, entry };\n";
  const prev = process.env[helpers.childEnv];
  process.env[helpers.childEnv] = "1";
  try {
    await viteBuild({
      configFile: ctx.configFile,
      root: ctx.root,
      mode: ctx.mode,
      logLevel: "warn",
      plugins: [
        {
          name: "sibu-prerender-driver",
          resolveId: (id: string) => (id === DRIVER_ID ? DRIVER_RESOLVED : null),
          load: (id: string) => (id === DRIVER_RESOLVED ? driverSource : null),
        },
      ],
      build: {
        ssr: true,
        outDir: tmpDir,
        emptyOutDir: true,
        copyPublicDir: false,
        minify: false,
        sourcemap: false,
        rollupOptions: { input: DRIVER_ID, output: { format: "es", entryFileNames: "driver.mjs" } },
      },
    });
  } finally {
    if (prev === undefined) delete process.env[helpers.childEnv];
    else process.env[helpers.childEnv] = prev;
  }
  await fs.writeFile(path.join(tmpDir, "package.json"), '{ "type": "module" }\n', "utf8");

  // Data at build time: relative API URLs go to `fetch` (a base URL) or to a
  // custom function, and a request that never reaches the API fails the build
  // naming the route that made it.
  const currentRoute = new AsyncLocalStorage<{ route: string; failures: string[] }>();
  const realFetch = globalThis.fetch;
  const custom = typeof options.fetch === "function" ? options.fetch : null;
  const apiBase = typeof options.fetch === "string" ? options.fetch.replace(/\/+$/, "") : origin;
  const buildFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : apiBase + (raw.startsWith("/") ? raw : `/${raw}`);
    try {
      return await (custom ?? realFetch)(
        typeof input === "object" && !(input instanceof URL) ? new Request(url, input) : url,
        init,
      );
    } catch (err) {
      const store = currentRoute.getStore();
      const reason = err instanceof Error ? err.message : String(err);
      store?.failures.push(`GET ${url} failed (${reason})`);
      throw err;
    }
  }) as typeof fetch;

  const driverUrl = pathToFileURL(path.join(tmpDir, "driver.mjs")).href;
  const results: PrerenderResult[] = [];
  globalThis.fetch = buildFetch;
  try {
    const driver = (await import(driverUrl)) as DriverModule;
    const entry = driver.entry;
    if (!Array.isArray(entry.routes)) {
      throw new Error(
        `[sibu prerender] the server entry ${options.server} must export \`routes\` (the app's route table)`,
      );
    }

    // 2 — the URL list.
    const explicit = Array.isArray(options.routes) ? options.routes : null;
    const auto = explicit === null;
    const listed: PrerenderRoute[] = (
      explicit
        ? explicit.map((r): PrerenderRoute => (typeof r === "string" ? { path: r } : r))
        : (await expandRoutes(entry.routes)).map((p): PrerenderRoute => ({ path: p }))
    ).filter((r) => r.path !== options.notFound);
    const trailingSlash = options.trailingSlash === "never" ? "never" : "always";
    const planned = listed.map((route) => ({ route, file: helpers.outputFileFor(route, trailingSlash) }));
    const seen = new Map<string, string>();
    for (const { route, file } of planned) {
      helpers.resolveInsideOutDir(path, outDir, file);
      const other = seen.get(file);
      if (other !== undefined) {
        throw new Error(
          `[sibu prerender] "${other}" and "${route.path}" would both be written to ${file}; ` +
            "a query variant needs its own `output` file.",
        );
      }
      seen.set(file, route.path);
    }

    const renderOptions = {
      router: { ...(entry.routerOptions ?? {}), head: entry.head },
      app: entry.app,
      timeout: options.timeout ?? 15_000,
      // A per-request page is written as the shell plus its route head: it is
      // never rendered at build time, so its request-only fetches never run.
      headOnly: ["ssr"] as const,
      hydration: options.hydration,
      nonce: options.nonce,
      maxStateBytes: options.maxStateBytes,
    };
    const render = async (url: string) => {
      const store = { route: url, failures: [] as string[] };
      const result = await currentRoute.run(store, () => driver.renderRoute(entry.routes, url, renderOptions));
      assertPrerendered(url, result, store.failures, renderOptions.timeout);
      return result;
    };

    if (options.shell !== false) await fs.writeFile(path.join(outDir, options.shell ?? "200.html"), shell, "utf8");

    // 3 — render and write.
    const redirects: Array<{ from: string; to: string; status: number }> = [];
    const indexable: string[] = [];
    const queue = [...planned];
    const concurrency = Math.max(1, options.concurrency ?? 4);
    const write = async (file: string, html: string) => {
      const target = helpers.resolveInsideOutDir(path, outDir, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, html, "utf8");
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          const { route, file } = job;
          const started = Date.now();
          const result = await render(route.path);
          // A guard's redirect (a login page) depends on the visitor: it is not
          // a static redirect, and the route is left to the browser.
          if (result.location !== null && result.redirectBy === "guard") {
            results.push({
              route: route.path,
              file: "",
              ms: Date.now() - started,
              status: result.status,
              kind: "skipped",
            });
            continue;
          }
          if (result.location !== null) {
            redirects.push({ from: route.path, to: result.location, status: result.status });
            results.push({
              route: route.path,
              file: "",
              ms: Date.now() - started,
              status: result.status,
              kind: "redirect",
            });
            continue;
          }
          // Found by "auto" behind a guard (an account page): not pre-renderable.
          if (auto && result.failure === "guard") {
            results.push({
              route: route.path,
              file: "",
              ms: Date.now() - started,
              status: result.status,
              kind: "skipped",
            });
            continue;
          }
          if (result.status >= 400) {
            throw new Error(
              `[sibu prerender] ${route.path} answered ${result.status}${result.failure ? ` (${result.failure})` : ""}; ` +
                "list only pages that exist (the `*` route becomes 404.html through `notFound`).",
            );
          }
          // A per-request or browser-only route ships the shell plus its head.
          const body = result.render === "client" || result.render === "ssr" ? "" : result.html;
          const state = body ? result.state : "";
          await write(file, injectIntoShell(shell, { body, head: result.head, state }, options.container));
          if (!result.noindex && result.render !== "client") {
            const pathname = route.path.split(/[?#]/)[0];
            indexable.push(
              trailingSlash === "always" && pathname !== "/" ? `${pathname.replace(/\/+$/, "")}/` : pathname,
            );
          }
          results.push({
            route: route.path,
            file,
            ms: Date.now() - started,
            status: result.status,
            kind: body ? "page" : "shell",
          });
        }
      }),
    );

    // The `*` route, as the static server's 404 page.
    const notFound = options.notFound ?? "/404";
    if (notFound) {
      const started = Date.now();
      const result = await render(notFound);
      if (result.status === 404) {
        await write(
          "404.html",
          injectIntoShell(shell, { body: result.html, head: result.head, state: result.state }, options.container),
        );
        results.push({ route: notFound, file: "404.html", ms: Date.now() - started, status: 404, kind: "not-found" });
      }
    }

    if (redirects.length > 0) await write("redirects.json", `${JSON.stringify(redirects, null, 2)}\n`);

    // 4 — sitemap and robots.
    if (options.sitemap !== false && indexable.length > 0) {
      indexable.sort();
      await write("sitemap.xml", buildSitemap(origin, indexable));
    }
    if (options.robots) {
      const extra = typeof options.robots === "string" ? `${options.robots.trim()}\n` : "";
      const sitemapLine = options.sitemap !== false && indexable.length > 0 ? `Sitemap: ${origin}/sitemap.xml\n` : "";
      await write("robots.txt", `User-agent: *\nAllow: /\n${extra}${sitemapLine}`);
    }
  } finally {
    globalThis.fetch = realFetch;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
  return results;
}
