// @vitest-environment node
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findEntryInHtml, outputFileFor } from "../src/build/prerender";

// ---------------------------------------------------------------------------
// sibuVitePlugin({ prerender }): a real `vite build` of examples/prerender-spa
// writes one static HTML file per route, each with its own head and content.
// ---------------------------------------------------------------------------

const config = fileURLToPath(new URL("../examples/prerender-spa/vite.config.ts", import.meta.url));
let outDir: string;
const page = (file: string) => readFile(join(outDir, file), "utf8");

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "sibu-prerender-"));
  const { build } = await import("vite");
  await build({ configFile: config, logLevel: "silent", build: { outDir, emptyOutDir: true } });
}, 120_000);

afterAll(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe("prerender build", () => {
  it("writes one HTML file per route plus the SPA shell, and removes its scratch dir", async () => {
    for (const f of ["index.html", "cotizar/index.html", "galeria/index.html", "200.html"]) {
      expect((await stat(join(outDir, f))).isFile()).toBe(true);
    }
    await expect(stat(join(outDir, ".sibu-prerender"))).rejects.toThrow();
  });

  it("gives each route its own title, description and Open Graph tags", async () => {
    const home = await page("index.html");
    expect(home).toContain('<title data-sibu-base-title="Wraps Studio">Custom vehicle wraps · Wraps Studio</title>');
    expect(home).toContain('<meta name="description" content="Design your wrap online and get it installed in a day."');
    expect(home).toContain('<meta property="og:image" content="https://wraps.example/og/home.png"');
    expect(home).toContain('<link rel="canonical" href="https://wraps.example/"');

    const quote = await page("cotizar/index.html");
    expect(quote).toContain(">Get a quote · Wraps Studio</title>");
    expect(quote).toContain('content="Tell us about your vehicle and get a price within 24 hours."');
    expect(quote).toContain('<meta property="og:url" content="https://wraps.example/cotizar"');
    expect(quote).not.toContain("og/home.png");
  });

  it("contains each route's rendered content, including a lazy route and awaited data", async () => {
    expect(await page("index.html")).toContain("<h1>Custom vehicle wraps</h1>");
    expect(await page("cotizar/index.html")).toContain('<input id="vehicle" name="vehicle">');
    const gallery = await page("galeria/index.html");
    expect(gallery).toContain("<h1>Gallery</h1>");
    expect(gallery).toContain("Matte black pickup");
    expect(gallery).toContain("Food truck, full print");
  });

  it("keeps the built client script so the browser takes over", async () => {
    const shell = await page("200.html");
    const script = /<script type="module" crossorigin src="([^"]+)"/.exec(shell)?.[1];
    expect(script).toMatch(/^\/assets\/index-.+\.js$/);
    for (const f of ["index.html", "cotizar/index.html", "galeria/index.html"]) {
      expect(await page(f)).toContain(`src="${script}"`);
    }
    expect(shell).toContain('<div id="app"></div>');
  });
});

describe("prerender helpers", () => {
  it("finds the module entry in index.html", () => {
    expect(findEntryInHtml('<script type="module" src="/src/main.ts"></script>')).toBe("/src/main.ts");
    expect(findEntryInHtml('<script src="/src/a.ts" type="module"></script>')).toBe("/src/a.ts");
    expect(findEntryInHtml("<script src=/x.js></script>")).toBeNull();
  });

  it("maps routes to files and refuses paths that escape the output dir", () => {
    expect(outputFileFor({ path: "/" })).toBe("index.html");
    expect(outputFileFor({ path: "/a/b?x=1" })).toBe("a/b/index.html");
    expect(outputFileFor({ path: "/caf%C3%A9" })).toBe("café/index.html");
    expect(outputFileFor({ path: "/x", output: "x.html" })).toBe("x.html");
    expect(() => outputFileFor({ path: "/../etc" })).toThrow(/unsafe/);
    expect(() => outputFileFor({ path: "/x", output: "../x.html" })).toThrow(/unsafe/);
    expect(() => outputFileFor({ path: "x" })).toThrow(/must start/);
  });
});
