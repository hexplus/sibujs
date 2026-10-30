/**
 * Build-time pre-rendering for single-page apps.
 *
 * An SPA built with `createRouter({ mode: "history" })` ships an empty
 * `<div id="app">`: crawlers and link-preview bots see no content, and every
 * route shares one `<title>`. A render server fixes that, but many apps are
 * served as static files by a backend that is not Node. This renders each
 * listed route ONCE, at build time, and writes it as a static HTML file.
 *
 * How a route is rendered:
 *
 *  1. The app's own client entry is built a second time as a Node module (a
 *     Vite SSR build of the same entry, with the same config).
 *  2. In a fresh worker thread — one per route, so module state such as the
 *     router singleton never leaks between routes — a jsdom document is created
 *     from the BUILT `index.html` at the route's URL and registered as the
 *     global DOM, and the entry is imported. It runs exactly as in a browser.
 *  3. The page is serialized once it has settled: every `fetch`, every promise
 *     passed to `prerenderWait()`, the router's initial navigation and its lazy
 *     route chunks have finished, and the DOM has been quiet for `settle` ms.
 *  4. The document — rendered body, and the head the router produced for the
 *     route (title, description, canonical, Open Graph) — is written to
 *     `<outDir>/<route>/index.html`. The built `<script>` tags are kept, so the
 *     browser loads the client, which takes over (see the AGENTS.md recipe).
 *
 * Everything here is Node-only and loaded lazily, so importing `sibujs/build`
 * elsewhere never pulls in a Node built-in.
 */

/** One route to pre-render. */
export interface PrerenderRoute {
  /** The route URL, e.g. `"/pricing"` (a query string is allowed). */
  path: string;
  /** Output file, relative to the build output dir. Default: `<path>/index.html`. */
  output?: string;
}

export interface PrerenderOptions {
  /**
   * Routes to render. With `server`, defaults to `"auto"`: every route of the
   * exported table without params, plus the paths `getStaticPaths()` lists
   * for dynamic ones. A query variant (`"/cotizar?servicio=dtf"`) is rendered
   * only when listed, and needs its own `output` file.
   */
  routes?: Array<string | PrerenderRoute> | "auto";
  /**
   * A SERVER ENTRY module (relative to the Vite root) exporting the app's
   * `routes`, and optionally `head` (router head defaults), `routerOptions`
   * and `app` (the shell around `Route()`). Routes are then rendered with
   * `renderRoute()` on the built-in server DOM — the request-scoped router,
   * async data, the collected head and transferred state — with no jsdom.
   * Without it, the 4.13 mode runs the client entry in jsdom.
   */
  server?: string;
  /** Output dir (relative to the Vite root). Default: Vite's `build.outDir`. */
  outDir?: string;
  /**
   * Data at build time: a base URL that relative `fetch()` URLs (`/api/…`)
   * resolve against (a running API), or a `fetch` implementation. A request
   * that cannot reach it fails the build, naming the route. Default: `origin`.
   * Server-entry mode only.
   */
  fetch?: string | typeof fetch;
  /**
   * `"always"` (default): `/cotizar` is written as `cotizar/index.html`, the
   * sitemap lists `/cotizar/`. `"never"`: `cotizar.html`, listed as `/cotizar`
   * (the static server must map `/cotizar` to `cotizar.html`).
   */
  trailingSlash?: "always" | "never";
  /**
   * URL rendered through the `*` route and written as `404.html` (when it
   * answers 404). Default `"/404"` with `server`; off otherwise. `false` to skip.
   */
  notFound?: string | false;
  /** Write `sitemap.xml` (pages not `noindex`, not `render: "client"`). Default `true` with `server`, `false` otherwise. */
  sitemap?: boolean;
  /** Write `robots.txt` pointing at the sitemap; a string adds rules (`"Disallow: /admin"`). Default `false`. */
  robots?: boolean | string;
  /** `"adopt"`: mark the output for `hydrate(App, root, { strategy: "adopt" })`. Server-entry mode only. */
  hydration?: "adopt" | "replace";
  /**
   * CSP nonce attribute for the transfer script. Server-entry mode only.
   *
   * A static file carries the SAME value on every response, and a nonce that
   * never changes protects nothing: injected markup can reuse it. Use it only
   * as a PLACEHOLDER your server replaces with a fresh nonce per response
   * (nginx `sub_filter`, a middleware), the same value its CSP header sends.
   * Without such a server, allow the script by hash (`'sha256-…'`) instead.
   */
  nonce?: string;
  /** Cap on each page's transferred state in bytes. Server-entry mode only. */
  maxStateBytes?: number;
  /** Id of the element the body renders into. Default `"app"`. Server-entry mode only. */
  container?: string;
  /**
   * The client entry module, relative to the Vite root. Default: the first
   * `<script type="module" src>` in the source `index.html`.
   */
  entry?: string;
  /**
   * Origin of the URL each route is rendered at. Relative `fetch()` URLs
   * resolve against it, and `location` reports it. Default `"http://localhost"`.
   */
  origin?: string;
  /** Per-route time limit in ms before the build fails. Default 15000. */
  timeout?: number;
  /** How long the DOM must stay quiet, with nothing pending, before serializing. Default 50 ms. */
  settle?: number;
  /**
   * Where to keep an untouched copy of the SPA shell (the built `index.html`
   * before `/` is pre-rendered over it), for the backend's fallback route.
   * Default `"200.html"`; `false` to skip it.
   */
  shell?: string | false;
  /** Routes rendered at the same time. Default 4. */
  concurrency?: number;
}

/** What the pre-renderer needs to know about the Vite build that just ran. */
export interface PrerenderBuildContext {
  /** Vite root (absolute). */
  root: string;
  /** Build output dir (absolute). */
  outDir: string;
  /** The Vite config file used for the client build, if any. */
  configFile?: string | false;
  /** Vite mode. */
  mode?: string;
}

/** One rendered route. */
export interface PrerenderResult {
  route: string;
  file: string;
  ms: number;
  /** HTTP status the route answered with (server-entry mode). */
  status?: number;
  /**
   * `page` (rendered body), `shell` (head only), `redirect` (listed in
   * redirects.json), `not-found` (404.html), `skipped` (a guard rejected it).
   */
  kind?: "page" | "shell" | "redirect" | "not-found" | "skipped";
}

/** Environment variable marking the nested SSR build, so it does not pre-render again. */
export const PRERENDER_CHILD_ENV = "SIBU_PRERENDER_CHILD";

const MODULE_SCRIPT = /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i;
const MODULE_SCRIPT_SRC_FIRST = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*\btype\s*=\s*["']module["'][^>]*>/i;

/**
 * Find the client entry of a Vite app from its source `index.html`.
 * @internal
 */
export function findEntryInHtml(html: string): string | null {
  const m = MODULE_SCRIPT.exec(html) ?? MODULE_SCRIPT_SRC_FIRST.exec(html);
  return m ? m[1] : null;
}

/**
 * The output file for a route, relative to the output dir. Refuses paths that
 * could escape it.
 * @internal
 */
export function outputFileFor(route: PrerenderRoute, trailingSlash: "always" | "never" = "always"): string {
  if (route.output) {
    const output = route.output;
    // Relative to the output dir; a leading slash is accepted and dropped. A
    // drive (`C:\x`, `C:x`) is refused rather than dropped: it names another
    // root, not a place inside this one.
    if (/^[A-Za-z]:/.test(output) || output.includes("\0")) {
      throw new Error(`[sibu prerender] unsafe output "${output}": must be a path relative to the output dir`);
    }
    const segments = output.split(/[\\/]+/).filter(Boolean);
    if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
      throw new Error(`[sibu prerender] unsafe output "${output}": "." and ".." segments are not allowed`);
    }
    return segments.join("/");
  }
  const pathname = route.path.split(/[?#]/)[0];
  if (!pathname.startsWith("/")) throw new Error(`[sibu prerender] route "${route.path}" must start with "/"`);
  // Validate what each segment DECODES to: `%2e%2e` is `..`, `%2f` / `%5c`
  // are separators. Checking the encoded text first let `/%2e%2e/x` through.
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((raw) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        throw new Error(
          `[sibu prerender] route "${route.path}" has malformed percent-encoding in "${raw}"; ` +
            "encode a literal % as %25.",
        );
      }
      if (decoded === "." || decoded === ".." || /[\\/\0]/.test(decoded)) {
        throw new Error(
          `[sibu prerender] unsafe route "${route.path}": segment "${raw}" decodes to "${decoded}", ` +
            'which could leave the output dir (".", "..", or a path separator).',
        );
      }
      return decoded;
    });
  if (trailingSlash === "never" && segments.length > 0) {
    const last = segments.pop() as string;
    return [...segments, `${last}.html`].join("/");
  }
  return [...segments, "index.html"].join("/");
}

/**
 * Absolute destination of `file` inside `outDir`, refusing anything that
 * resolves outside it. The last line of defence at the write boundary, so a
 * path `outputFileFor` let through can still never escape.
 * @internal
 */
export function resolveInsideOutDir(
  path: {
    resolve: (...p: string[]) => string;
    relative: (a: string, b: string) => string;
    isAbsolute: (p: string) => boolean;
  },
  outDir: string,
  file: string,
): string {
  const root = path.resolve(outDir);
  const target = path.resolve(root, file);
  const rel = path.relative(root, target);
  // Compared by path segment, never by string prefix: `/out-evil` starts with
  // `/out` but is outside it.
  const escapes = rel === "" || rel === ".." || /^\.\.[\\/]/.test(rel) || path.isAbsolute(rel);
  if (escapes) throw new Error(`[sibu prerender] refusing to write "${file}": it resolves outside ${root}`);
  return target;
}

/**
 * Pre-render `options.routes` into `ctx.outDir`. Called by
 * `sibuVitePlugin({ prerender })` after the client build; callable directly
 * from a build script too.
 *
 * @param options Routes and rendering options.
 * @param ctx The finished client build.
 * @returns One entry per written file.
 * @throws When a route fails to render, throws, or does not settle in time.
 */
export async function prerender(options: PrerenderOptions, ctx: PrerenderBuildContext): Promise<PrerenderResult[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { createRequire } = await import("node:module");
  const requireFromRoot = createRequire(path.join(ctx.root, "package.json"));

  if (options.server) {
    const { prerenderFromServerEntry } = await import("./prerenderServer");
    return prerenderFromServerEntry(options, ctx, {
      outputFileFor,
      resolveInsideOutDir,
      loadViteBuild: () => loadViteBuild(requireFromRoot, fs, path, pathToFileURL),
      childEnv: PRERENDER_CHILD_ENV,
    });
  }

  if (options.routes === undefined || options.routes === "auto") {
    throw new Error(
      '[sibu prerender] `routes: "auto"` needs a server entry (`prerender.server`); list the routes instead.',
    );
  }
  const routes: PrerenderRoute[] = options.routes.map((r) => (typeof r === "string" ? { path: r } : r));
  if (options.notFound) routes.push({ path: options.notFound, output: "404.html" });
  if (routes.length === 0) return [];
  const trailingSlash = options.trailingSlash === "never" ? "never" : "always";
  const outDir = options.outDir ? path.resolve(ctx.root, options.outDir) : ctx.outDir;
  // Every destination is validated before anything is built or rendered, so an
  // unsafe route fails the build without touching the disk.
  const planned = routes.map((route) => {
    const file = outputFileFor(route, trailingSlash);
    resolveInsideOutDir(path, outDir, file);
    return { route, file };
  });
  const origin = (options.origin ?? "http://localhost").replace(/\/+$/, "");
  const timeout = options.timeout ?? 15_000;
  const settle = options.settle ?? 50;

  // A re-run finds `index.html` already rendered: use the kept shell then.
  const keptShell = path.join(ctx.outDir, typeof options.shell === "string" ? options.shell : "200.html");
  const templatePath = await fs
    .access(keptShell)
    .then(() => keptShell)
    .catch(() => path.join(ctx.outDir, "index.html"));
  const template = await fs.readFile(templatePath, "utf8");

  let entry = options.entry;
  if (!entry) {
    const sourceHtml = await fs.readFile(path.join(ctx.root, "index.html"), "utf8");
    entry = findEntryInHtml(sourceHtml) ?? undefined;
    if (!entry) {
      throw new Error("[sibu prerender] could not find the client entry in index.html; pass `prerender.entry`.");
    }
  }
  const entryAbs = path.resolve(ctx.root, entry.replace(/^\//, ""));

  // jsdom is resolved from the APP, which is where it has to be installed.
  const requireFromApp = createRequire(path.join(ctx.root, "package.json"));
  let jsdomPath: string;
  try {
    jsdomPath = requireFromApp.resolve("jsdom");
  } catch {
    throw new Error("[sibu prerender] needs jsdom to render routes. Install it: npm i -D jsdom");
  }

  const tmpDir = path.join(outDir, ".sibu-prerender");
  await fs.rm(tmpDir, { recursive: true, force: true });

  // 1 — the same entry, built for Node, with the app's own config and plugins.
  const viteBuild = await loadViteBuild(requireFromApp, fs, path, pathToFileURL);
  const prev = process.env[PRERENDER_CHILD_ENV];
  process.env[PRERENDER_CHILD_ENV] = "1";
  try {
    await viteBuild({
      configFile: ctx.configFile,
      root: ctx.root,
      mode: ctx.mode,
      logLevel: "warn",
      build: {
        ssr: entryAbs,
        outDir: tmpDir,
        emptyOutDir: true,
        copyPublicDir: false,
        minify: false,
        sourcemap: false,
        rollupOptions: { output: { format: "es", entryFileNames: "entry.mjs" } },
      },
    });
  } finally {
    if (prev === undefined) delete process.env[PRERENDER_CHILD_ENV];
    else process.env[PRERENDER_CHILD_ENV] = prev;
  }

  // The build emits ES modules, but its code-split chunks are `.js`. Node
  // without ESM syntax detection (before 22.7) parses a `.js` file outside a
  // `"type": "module"` package as CommonJS, so a lazy route chunk failed with
  // "Cannot use import statement outside a module". Declare the directory ESM.
  await fs.writeFile(path.join(tmpDir, "package.json"), '{ "type": "module" }\n', "utf8");
  const workerFile = path.join(tmpDir, "render-worker.mjs");
  await fs.writeFile(workerFile, WORKER_SOURCE, "utf8");
  const entryUrl = pathToFileURL(path.join(tmpDir, "entry.mjs")).href;
  const jsdomUrl = pathToFileURL(jsdomPath).href;

  await fs.mkdir(outDir, { recursive: true });
  if (options.shell !== false) {
    await fs.writeFile(path.join(outDir, options.shell ?? "200.html"), template, "utf8");
  }

  const results: PrerenderResult[] = [];
  const indexable: string[] = [];
  const queue = [...planned];
  const concurrency = Math.max(1, options.concurrency ?? 4);
  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          const { route, file } = job;
          const started = Date.now();
          const html = await renderInWorker(workerFile, {
            entryUrl,
            jsdomUrl,
            html: template,
            url: origin + route.path,
            route: route.path,
            timeout,
            settle,
          });
          // Re-checked at the write boundary itself.
          const target = resolveInsideOutDir(path, outDir, file);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, html, "utf8");
          results.push({ route: route.path, file, ms: Date.now() - started });
          if (file !== "404.html" && !/<meta\b[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html)) {
            const pathname = route.path.split(/[?#]/)[0];
            indexable.push(
              trailingSlash === "always" && pathname !== "/" ? `${pathname.replace(/\/+$/, "")}/` : pathname,
            );
          }
        }
      }),
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
  // Opt-in here: a 4.13 build writes exactly what it wrote before.
  if (options.sitemap && indexable.length > 0) {
    const { buildSitemap } = await import("./prerenderServer");
    await fs.writeFile(path.join(outDir, "sitemap.xml"), buildSitemap(origin, indexable.sort()), "utf8");
  }
  if (options.robots) {
    const extra = typeof options.robots === "string" ? `${options.robots.trim()}\n` : "";
    const sitemapLine = options.sitemap && indexable.length > 0 ? `Sitemap: ${origin}/sitemap.xml\n` : "";
    await fs.writeFile(path.join(outDir, "robots.txt"), `User-agent: *\nAllow: /\n${extra}${sitemapLine}`, "utf8");
  }
  return results;
}

type ViteBuild = (config: Record<string, unknown>) => Promise<unknown>;

/**
 * The file an export-map entry points at for an ES-module `import`.
 * @internal
 */
export function esmEntryOf(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object") return undefined;
  const conditions = entry as Record<string, unknown>;
  for (const key of ["import", "module-sync", "default"]) {
    const found = esmEntryOf(conditions[key]);
    if (found) return found;
  }
  return undefined;
}

/**
 * Vite's `build()`, from the app's own Vite, loaded as an ES module.
 *
 * `createRequire().resolve("vite")` follows REQUIRE conditions. Node versions
 * that honor `"module-sync"` (22.10+) are sent to Vite's ESM build, but older
 * ones — 22.3.0, this package's declared minimum — get `index.cjs`, which
 * attaches `build` in a loop that Node's CommonJS export detection cannot see,
 * so `import()` of it exposed no `build` at all. The ESM entry is therefore
 * read from Vite's export map; the CommonJS interop `default` is the fallback.
 */
async function loadViteBuild(
  requireFromApp: { resolve: (id: string) => string },
  fs: { readFile: (p: string, enc: "utf8") => Promise<string> },
  path: { dirname: (p: string) => string; join: (...p: string[]) => string },
  pathToFileURL: (p: string) => URL,
): Promise<ViteBuild> {
  let resolved: string;
  try {
    resolved = requireFromApp.resolve("vite");
  } catch {
    throw new Error("[sibu prerender] needs Vite to build the entry for Node, and could not resolve it from the app.");
  }
  let url = pathToFileURL(resolved).href;
  try {
    const pkgPath = requireFromApp.resolve("vite/package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8")) as { exports?: Record<string, unknown> };
    const entry = esmEntryOf(pkg.exports?.["."]);
    if (entry) url = pathToFileURL(path.join(path.dirname(pkgPath), entry)).href;
  } catch {
    // No readable export map: keep the require-resolved entry.
  }
  const mod = (await import(url)) as { build?: ViteBuild; default?: { build?: ViteBuild } };
  const build = mod.build ?? mod.default?.build;
  if (typeof build !== "function") {
    throw new Error(`[sibu prerender] the Vite module at ${url} has no build() function.`);
  }
  return build;
}

interface WorkerInput {
  entryUrl: string;
  jsdomUrl: string;
  html: string;
  url: string;
  route: string;
  timeout: number;
  settle: number;
}

async function renderInWorker(workerFile: string, input: WorkerInput): Promise<string> {
  const { Worker } = await import("node:worker_threads");
  return new Promise<string>((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: input });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
      // The app may leave timers or sockets running; the page is captured.
      void worker.terminate();
    };
    // Backstop in case the worker cannot even report its own timeout.
    const timer = setTimeout(
      () => finish(() => reject(new Error(`[sibu prerender] ${input.route}: worker did not respond`))),
      input.timeout + 5_000,
    );
    worker.once("message", (msg: { html?: string; error?: string }) => {
      clearTimeout(timer);
      if (typeof msg.html === "string") finish(() => resolve(msg.html as string));
      else finish(() => reject(new Error(`[sibu prerender] ${input.route}: ${msg.error}`)));
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      finish(() => reject(new Error(`[sibu prerender] ${input.route}: ${err instanceof Error ? err.stack : err}`)));
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      finish(() => reject(new Error(`[sibu prerender] ${input.route}: worker exited (${code}) before rendering`)));
    });
  });
}

/**
 * The per-route renderer, run in its own worker thread. Plain ES module source
 * so it needs no build step of its own.
 */
const WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";

const { entryUrl, jsdomUrl, html, url, route, timeout, settle } = workerData;
const fail = (err) => parentPort.postMessage({ error: err instanceof Error ? (err.stack || err.message) : String(err) });

try {
  const jsdom = await import(jsdomUrl);
  const JSDOM = jsdom.JSDOM ?? jsdom.default.JSDOM;
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const win = dom.window;
  // Read before the app runs: the router may replace it with the route title.
  const templateTitle = win.document.title;

  // Register the document as THE global DOM. Node already has a few of these
  // names (Event, EventTarget, …); the DOM's own must win, or an event the app
  // builds could not be dispatched on a DOM node.
  const FORCE = new Set(["Event", "EventTarget", "CustomEvent", "MessageEvent", "DOMException"]);
  for (const key of Object.getOwnPropertyNames(win)) {
    if (key in globalThis && !FORCE.has(key)) continue;
    try { globalThis[key] = win[key]; } catch {}
  }
  globalThis.window = win;
  globalThis.self = win;
  globalThis.document = win.document;

  let lastActivity = Date.now();
  const pending = new Set();
  const errors = [];
  const track = (p) => {
    const tracked = Promise.resolve(p).then(() => {}, () => {});
    pending.add(tracked);
    tracked.finally(() => { pending.delete(tracked); lastActivity = Date.now(); });
  };

  // Hold serialization while \`p\` is pending, WITHOUT handling it: the caller
  // receives a promise that settles exactly as \`p\` does, so a rejection the
  // app handles behaves normally and one it ignores still reaches the
  // unhandledRejection listener below (attaching a handler to \`p\` itself
  // would silently mark it handled).
  const observe = (p) => {
    let release;
    const tracked = new Promise((r) => { release = r; });
    pending.add(tracked);
    tracked.finally(() => { pending.delete(tracked); lastActivity = Date.now(); });
    return Promise.resolve(p).then(
      (value) => { release(); return value; },
      (error) => { release(); throw error; },
    );
  };

  // Every fetch holds serialization until it settles; relative URLs resolve
  // against the route's URL, as they would in the browser.
  const nodeFetch = globalThis.fetch;
  if (typeof nodeFetch === "function") {
    const wrapped = (input, init) => {
      const target = typeof input === "string" || input instanceof URL ? new URL(String(input), url) : input;
      return observe(nodeFetch(target, init));
    };
    globalThis.fetch = wrapped;
    win.fetch = wrapped;
  }

  // A fetch settles when the HEADERS arrive; the data the page renders comes
  // from a body reader that may still be waiting for the rest of the response.
  // Each reader call is held like the fetch itself. Patched on the prototype —
  // this thread exists only to render one route — so clones, and Responses the
  // app builds itself, are covered, and \`this\` / brand checks are the native
  // ones. Bodies nobody reads are never touched, so an unused or long-lived
  // body does not hold the page. Reading \`response.body\` directly as a stream
  // is NOT held (a stream may never end); wrap such a read in prerenderWait().
  const ResponseCtor = globalThis.Response;
  if (typeof ResponseCtor === "function") {
    const proto = ResponseCtor.prototype;
    for (const name of ["arrayBuffer", "blob", "bytes", "formData", "json", "text"]) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      const original = descriptor?.value;
      if (typeof original !== "function") continue;
      Object.defineProperty(proto, name, {
        ...descriptor,
        value: {
          // A method-shorthand keeps the native name and is not constructible.
          [name](...args) {
            return observe(Reflect.apply(original, this, args));
          },
        }[name],
      });
    }
  }

  globalThis[Symbol.for("sibujs.prerender.v1")] = { route, wait: track };

  new win.MutationObserver(() => { lastActivity = Date.now(); }).observe(win.document, {
    subtree: true, childList: true, attributes: true, characterData: true,
  });
  win.addEventListener("error", (e) => errors.push(e.error ?? e.message));
  process.on("unhandledRejection", (reason) => errors.push(reason));

  await import(entryUrl);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const started = Date.now();
  for (;;) {
    if (errors.length > 0) throw errors[0];
    if (Date.now() - started > timeout) {
      throw new Error("did not settle within " + timeout + " ms (" + pending.size + " pending request(s) or prerenderWait() promise(s)). " +
        "Await the data, skip it with isPrerendering(), or drop the route from prerender.routes.");
    }
    if (pending.size > 0) await Promise.race([Promise.all([...pending]), sleep(settle)]);
    await sleep(settle);
    if (pending.size === 0 && Date.now() - lastActivity >= settle) break;
  }
  if (errors.length > 0) throw errors[0];

  // The template title travels with the page, so the client router can give it
  // back to a route that sets no title of its own.
  const titleEl = win.document.head.querySelector("title");
  if (titleEl && !titleEl.hasAttribute("data-sibu-base-title")) titleEl.setAttribute("data-sibu-base-title", templateTitle);

  parentPort.postMessage({ html: dom.serialize() });
} catch (err) {
  fail(err);
}
`;
