// @vitest-environment node
//
// Build-time pre-rendering from a server entry (`prerender.server`): a real
// `vite build` of fixtures/ssr-app against a running stub API, with no DOM
// library — then the output served by a plain Python static server.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG } from "../fixtures/ssr-app/src/api";
import { buildSitemap, expandRoutes, injectIntoShell } from "../src/build/prerenderServer";

const config = fileURLToPath(new URL("../fixtures/ssr-app/vite.config.ts", import.meta.url));
let outDir: string;
let api: Server;
const apiRequests: string[] = [];
const page = (file: string) => readFile(join(outDir, file), "utf8");

function startApi(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      apiRequests.push(url.pathname);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/api/catalog") return json(200, CATALOG);
      if (url.pathname.startsWith("/api/catalog/")) {
        const p = CATALOG.find((x) => x.id === decodeURIComponent(url.pathname.slice(13)));
        return p ? json(200, p) : json(404, {});
      }
      // A per-request endpoint: it needs the visitor's credentials, which a
      // build does not have. `/estado` (render: "ssr") must never call it.
      if (url.pathname === "/api/status") {
        req.socket.destroy();
        return;
      }
      json(404, {});
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function build(out: string, apiBase: string | undefined): Promise<void> {
  const { build: viteBuild } = await import("vite");
  const prev = process.env.SIBU_FIXTURE_API;
  if (apiBase === undefined) delete process.env.SIBU_FIXTURE_API;
  else process.env.SIBU_FIXTURE_API = apiBase;
  try {
    await viteBuild({ configFile: config, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  } finally {
    if (prev === undefined) delete process.env.SIBU_FIXTURE_API;
    else process.env.SIBU_FIXTURE_API = prev;
  }
}

beforeAll(async () => {
  api = await startApi();
  outDir = await mkdtemp(join(tmpdir(), "sibu-prerender-server-"));
  await build(outDir, `http://127.0.0.1:${(api.address() as AddressInfo).port}`);
}, 180_000);

afterAll(async () => {
  api?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe("prerender from a server entry", () => {
  it("writes every route of the table, the getStaticPaths pages, 404.html, the shell, sitemap and robots", async () => {
    const files = [
      "index.html",
      "cotizar/index.html",
      "producto/taza/index.html",
      "producto/gorra/index.html",
      "producto/camiseta/index.html",
      "galeria/index.html",
      "ayuda/envios/index.html",
      "estado/index.html",
      "disenador/index.html",
      "admin/index.html",
      "404.html",
      "200.html",
      "sitemap.xml",
      "robots.txt",
      "redirects.json",
    ];
    for (const f of files) expect((await stat(join(outDir, f))).isFile(), f).toBe(true);
    expect((await readdir(outDir)).some((f) => f.startsWith(".sibu-prerender"))).toBe(false);
    // A guard-protected page is not pre-renderable: no file for it.
    await expect(stat(join(outDir, "mi-cuenta/index.html"))).rejects.toThrow();
  });

  it("renders the landing page with the product grid from the API, its head, and the transferred state", async () => {
    const home = await page("index.html");
    expect(home.match(/<article class="card"/g)?.length).toBe(3);
    expect(home).toContain('<title data-sibu-base-title="Estampados Sibu">Inicio · Estampados Sibu</title>');
    expect(home).toContain('<meta property="og:image" content="https://fixture.test/og/home.png" data-sibu-head="" />');
    expect(home).toContain('<link rel="alternate" hreflang="en" href="https://fixture.test/en/" data-sibu-head="" />');
    expect(home).toContain('<script type="application/ld+json"');
    expect(home).toContain("window.__SIBU_TRANSFER__=");
    expect(home).toContain('data-sibu-h="');
    expect(home).toMatch(/<script type="module" crossorigin src="\/assets\/index-[^"]+\.js">/);
    expect(apiRequests).toContain("/api/catalog");
    // Exactly one <title>.
    expect(home.match(/<title/g)?.length).toBe(1);
  });

  it("renders each product page through getStaticPaths and a query route", async () => {
    // The output carries adoption markers (`hydration: "adopt"`), hence `<h1 …>`.
    expect(await page("producto/gorra/index.html")).toMatch(/<h1[^>]*>Gorra bordada<\/h1>/);
    expect(await page("producto/gorra/index.html")).toContain(
      '<title data-sibu-base-title="Estampados Sibu">Producto gorra · Estampados Sibu</title>',
    );
    expect(await page("cotizar/index.html")).toContain("Cotiza tu pedido");
  });

  it("ships only the shell and head for render: client / ssr routes", async () => {
    const designer = await page("disenador/index.html");
    expect(designer).toContain("Diseñador · Estampados Sibu</title>");
    expect(designer).toContain('<div id="app"></div>');
    expect(designer).not.toContain("__SIBU_TRANSFER__");
    const status = await page("estado/index.html");
    expect(status).toContain('<div id="app"></div>');
    // A per-request page is not rendered at build time: its request-only API
    // was never called, its route head is there, and nothing transfers.
    expect(apiRequests).not.toContain("/api/status");
    expect(status).toContain("Estado · Estampados Sibu</title>");
    expect(status).toContain('<meta name="robots" content="noindex"');
    expect(status).not.toContain("__SIBU_TRANSFER__");
    expect(await page("admin/index.html")).toContain('<meta name="robots" content="noindex, nofollow"');
  });

  it("writes the * route as 404.html and lists redirects for the backend", async () => {
    const notFound = await page("404.html");
    expect(notFound).toContain("Página no encontrada");
    expect(notFound).toContain("No encontrado · Estampados Sibu</title>");
    const redirects = JSON.parse(await page("redirects.json"));
    // Only a route's own redirect is static; `/pedidos` redirects through a
    // guard (it depends on the visitor) and is left to the browser.
    expect(redirects).toEqual([{ from: "/cotizacion", to: "/cotizar", status: 301 }]);
  });

  it("lists only indexable, server-rendered pages in the sitemap", async () => {
    const sitemap = await page("sitemap.xml");
    for (const p of ["/", "/cotizar/", "/producto/taza/", "/galeria/", "/ayuda/envios/"]) {
      expect(sitemap).toContain(`<loc>https://fixture.test${p}</loc>`);
    }
    for (const p of ["/admin", "/disenador", "/estado", "/404"]) expect(sitemap).not.toContain(`fixture.test${p}`);
    expect(await page("robots.txt")).toBe(
      "User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: https://fixture.test/sitemap.xml\n",
    );
  });

  it("fails the build naming the route when the API is unreachable", async () => {
    const out = await mkdtemp(join(tmpdir(), "sibu-prerender-noapi-"));
    try {
      // getStaticPaths() of the product route reads the catalog first.
      await expect(build(out, "http://127.0.0.1:9")).rejects.toThrow(
        /\[sibu prerender\] getStaticPaths\(\) of "\/producto\/:id" failed: .*point `prerender\.fetch` at it/,
      );
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("served by a plain Python static server", () => {
  const python = ["python3", "python"].find((cmd) => spawnSync(cmd, ["--version"]).status === 0);
  let proc: ChildProcess | undefined;
  let base = "";

  /** A port the OS reports free right now. */
  const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });

  beforeAll(async () => {
    if (!python) return;
    // Python can take seconds to start on a loaded machine, and a port can be
    // taken between choosing and binding it: wait until it answers, start again
    // on another port if it exited, and fail loudly rather than let the tests
    // run against nothing.
    const deadline = Date.now() + 50_000;
    while (Date.now() < deadline) {
      const port = await freePort();
      const child = spawn(python, ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", outDir], {
        stdio: "ignore",
      });
      let exited = false;
      child.once("exit", () => {
        exited = true;
      });
      proc = child;
      base = `http://127.0.0.1:${port}`;
      while (!exited && Date.now() < deadline) {
        try {
          await fetch(base);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      child.kill();
    }
    throw new Error("the Python static server did not start");
  }, 60_000);

  afterAll(() => {
    proc?.kill();
  });

  it.skipIf(!python)("GET / returns the full product grid and the Open Graph tags", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.match(/<article class="card"/g)?.length).toBe(3);
    expect(html).toMatch(/<meta property="og:title" content="Inicio"/);
    expect(html).toMatch(/<meta property="og:description" content="Estampado DTF, vinil y bordado\."/);
  });

  it.skipIf(!python)("GET /cotizar/ and a product page return their own pages", async () => {
    expect(await (await fetch(`${base}/cotizar/`)).text()).toContain("Cotiza tu pedido");
    expect(await (await fetch(`${base}/producto/taza/`)).text()).toMatch(/<h1[^>]*>Taza personalizada<\/h1>/);
  });
});

describe("prerender helpers (server-entry mode)", () => {
  it("expands static routes, getStaticPaths and redirects, skipping * and layouts", async () => {
    const paths = await expandRoutes([
      { path: "/" },
      { path: "/a/:id", getStaticPaths: () => [{ id: "x y" }, "/a/literal"] },
      { path: "/b/:id" },
      { path: "/old", redirect: "/" },
      { path: "/layout", children: [{ path: "/child" }] },
      { path: "*" },
    ]);
    expect(paths).toEqual(["/", "/a/x%20y", "/a/literal", "/old", "/layout/child"]);
  });

  it("refuses a getStaticPaths entry that leaves a param unset", async () => {
    await expect(expandRoutes([{ path: "/p/:a/:b", getStaticPaths: () => [{ a: "1" }] }])).rejects.toThrow(
      /leaves a param unset/,
    );
  });

  it("injects body, head and state into the shell, keeping the shell title for the router", () => {
    const shell =
      '<html><head><title>Shop</title></head><body><div id="app"></div><script type="module" src="/a.js"></script></body></html>';
    const html = injectIntoShell(shell, { body: "<p>x</p>", head: "<title>Page</title>", state: "<script>s</script>" });
    expect(html).toContain('<title data-sibu-base-title="Shop">Page</title>');
    expect(html).toContain('<div id="app"><p>x</p></div>');
    expect(html.indexOf("<script>s</script>")).toBeLessThan(html.indexOf("</body>"));
    expect(() => injectIntoShell("<html><body></body></html>", { body: "x", head: "", state: "" })).toThrow(
      /no element with id="app"/,
    );
  });

  it("escapes sitemap URLs", () => {
    expect(buildSitemap("https://x.test", ["/a&b"])).toContain("<loc>https://x.test/a&amp;b</loc>");
  });
});
