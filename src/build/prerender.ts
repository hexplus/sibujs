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
  /** Routes to render. */
  routes: Array<string | PrerenderRoute>;
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
export function outputFileFor(route: PrerenderRoute): string {
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

  const routes: PrerenderRoute[] = options.routes.map((r) => (typeof r === "string" ? { path: r } : r));
  if (routes.length === 0) return [];
  // Every destination is validated before anything is built or rendered, so an
  // unsafe route fails the build without touching the disk.
  const planned = routes.map((route) => {
    const file = outputFileFor(route);
    resolveInsideOutDir(path, ctx.outDir, file);
    return { route, file };
  });
  const origin = (options.origin ?? "http://localhost").replace(/\/+$/, "");
  const timeout = options.timeout ?? 15_000;
  const settle = options.settle ?? 50;

  const templatePath = path.join(ctx.outDir, "index.html");
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

  const tmpDir = path.join(ctx.outDir, ".sibu-prerender");
  await fs.rm(tmpDir, { recursive: true, force: true });

  // 1 — the same entry, built for Node, with the app's own config and plugins.
  const vite = (await import(pathToFileURL(requireFromApp.resolve("vite")).href)) as {
    build: (config: Record<string, unknown>) => Promise<unknown>;
  };
  const prev = process.env[PRERENDER_CHILD_ENV];
  process.env[PRERENDER_CHILD_ENV] = "1";
  try {
    await vite.build({
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

  const workerFile = path.join(tmpDir, "render-worker.mjs");
  await fs.writeFile(workerFile, WORKER_SOURCE, "utf8");
  const entryUrl = pathToFileURL(path.join(tmpDir, "entry.mjs")).href;
  const jsdomUrl = pathToFileURL(jsdomPath).href;

  if (options.shell !== false) {
    await fs.writeFile(path.join(ctx.outDir, options.shell ?? "200.html"), template, "utf8");
  }

  const results: PrerenderResult[] = [];
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
          const target = resolveInsideOutDir(path, ctx.outDir, file);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, html, "utf8");
          results.push({ route: route.path, file, ms: Date.now() - started });
        }
      }),
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
  return results;
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
