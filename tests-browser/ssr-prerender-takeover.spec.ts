import { mkdir, readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// The fixture app pre-rendered from its server entry, served as static files
// the way a Python/Go/PHP backend would (directory index, 404.html, the 200.html
// shell for browser-only routes), then taken over by the browser.

const root = fileURLToPath(new URL("..", import.meta.url));
let outDir = "";
const CATALOG = JSON.parse(
  JSON.stringify([
    { id: "taza", name: "Taza personalizada", price: 12, image: "/img/taza.png", color: "#d94f30" },
    { id: "gorra", name: "Gorra bordada", price: 18, image: "/img/gorra.png", color: "#2a6fdb" },
    { id: "camiseta", name: 'Camiseta "DTF" <premium>', price: 22, image: "/img/camiseta.png", color: "#1f9d55" },
  ]),
);
// One build and one server for the file: the tests share them.
test.describe.configure({ mode: "serial" });

let server: Server;
let base = "";
const apiHits: string[] = [];

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".xml": "application/xml" };

function api(pathname: string): unknown {
  if (pathname === "/api/catalog") return CATALOG;
  if (pathname.startsWith("/api/catalog/")) return CATALOG.find((p: { id: string }) => p.id === pathname.slice(13)) ?? null;
  if (pathname === "/api/status") return { ok: true, checkedAt: "now" };
  return null;
}

test.beforeAll(async ({ browserName }) => {
  // Browser projects run side by side: one build directory each.
  outDir = join(root, "node_modules", ".cache", `sibu-ssr-fixture-dist-${browserName}`);
  // A stub API for the build, then the build itself.
  const buildApi = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(api(new URL(req.url ?? "/", "http://x").pathname)));
  });
  await new Promise<void>((r) => buildApi.listen(0, "127.0.0.1", r));
  process.env.SIBU_FIXTURE_API = `http://127.0.0.1:${(buildApi.address() as AddressInfo).port}`;
  await mkdir(outDir, { recursive: true });
  const { build } = await import("vite");
  await build({ configFile: join(root, "fixtures/ssr-app/vite.config.ts"), logLevel: "silent", build: { outDir, emptyOutDir: true } });
  buildApi.close();

  // A plain static server: file, directory index, else 200.html / 404.html.
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/api/")) {
      apiHits.push(url.pathname);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(api(url.pathname)));
      return;
    }
    const file = normalize(join(outDir, decodeURIComponent(url.pathname)));
    const candidates = [file, join(file, "index.html")];
    for (const c of candidates) {
      try {
        if ((await stat(c)).isFile()) {
          res.writeHead(200, { "content-type": TYPES[extname(c)] ?? "application/octet-stream" });
          res.end(await readFile(c));
          return;
        }
      } catch {}
    }
    if (url.pathname.startsWith("/img/")) {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
      return;
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end(await readFile(join(outDir, "404.html")));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => {
  server?.close();
});

test("the landing page is adopted with no console errors and no /api/catalog request", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  apiHits.length = 0;
  await page.goto(`${base}/`);
  await expect(page.locator("#app")).toHaveAttribute("data-sibu-hydrated", "adopt");
  await expect(page.locator("article.card")).toHaveCount(3);
  // ClientOnly swapped the server's <img> for the recolored <canvas>.
  await expect(page.locator("article.card canvas")).toHaveCount(3);
  await expect(page.locator(".hero-img")).toBeVisible();
  expect(apiHits).not.toContain("/api/catalog");
  expect(errors).toEqual([]);
});

test("typing in the quote form before takeover survives it", async ({ page }) => {
  // Hold the client bundle so the user can type into the server-rendered form first.
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(/\/assets\/.*\.js$/, async (route) => {
    await held;
    await route.continue();
  });
  // Module scripts hold DOMContentLoaded, so wait for the server markup itself.
  await page.goto(`${base}/cotizar/`, { waitUntil: "commit" });
  await page.locator("#quote-name").waitFor();
  await page.fill("#quote-name", "Ada Lovelace");
  await expect(page.locator("#app")).not.toHaveAttribute("data-sibu-hydrated", "adopt");
  release();
  await expect(page.locator("#app")).toHaveAttribute("data-sibu-hydrated", "adopt");
  await expect(page.locator("#quote-name")).toHaveValue("Ada Lovelace");
  await expect(page.locator("#quote-name")).toBeFocused();
});

test("a browser-only route renders from the shell", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`${base}/admin/`);
  await expect(page.locator("h1")).toHaveText("Panel de administración");
  await expect(page).toHaveTitle("Administración · Estampados Sibu");
  expect(errors).toEqual([]);
});
