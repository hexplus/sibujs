// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findEntryInHtml, outputFileFor, prerender, resolveInsideOutDir } from "../src/build/prerender";

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

describe("prerender output paths stay inside the output dir", () => {
  const file = (path: string) => outputFileFor({ path });

  it("rejects encoded traversal, whatever the case of the escape", () => {
    // THE DEFECT: segments were checked before decoding, so this returned
    // "../outside/index.html".
    expect(() => file("/%2e%2e/outside")).toThrow(/unsafe route .*decodes to "\.\."/);
    expect(() => file("/%2E%2E/outside")).toThrow(/unsafe route/);
    expect(() => file("/a/%2e%2E/%2e%2e/outside")).toThrow(/unsafe route/);
    expect(() => file("/.%2e/outside")).toThrow(/unsafe route/);
    expect(() => file("/%2e/x")).toThrow(/unsafe route/);
  });

  it("rejects encoded forward and backward separators", () => {
    expect(() => file("/a%2F..%2F..%2Foutside")).toThrow(/path separator/);
    expect(() => file("/a%2f..%2foutside")).toThrow(/path separator/);
    expect(() => file("/..%5C..%5Coutside")).toThrow(/path separator/);
    expect(() => file("/a%5cb")).toThrow(/path separator/);
    // A raw backslash is a separator to Windows (and to WHATWG URL parsing).
    expect(() => file("/..\\outside")).toThrow(/path separator/);
    expect(() => file("/a%00b")).toThrow(/unsafe route/);
  });

  it("reports malformed percent-encoding with the offending segment", () => {
    expect(() => file("/100%")).toThrow(/malformed percent-encoding in "100%".*%25/);
    expect(() => file("/a/%E0%A4%A")).toThrow(/malformed percent-encoding/);
    expect(() => file("/%zz")).toThrow(/malformed percent-encoding/);
  });

  it("keeps valid nested, Unicode and query-bearing routes", () => {
    expect(file("/")).toBe("index.html");
    expect(file("/shop/items/42")).toBe("shop/items/42/index.html");
    expect(file("//shop//items/")).toBe("shop/items/index.html");
    expect(file("/caf%C3%A9")).toBe("café/index.html");
    expect(file("/caf%c3%a9/men%C3%BA")).toBe("café/menú/index.html");
    expect(file("/a%20b")).toBe("a b/index.html");
    expect(file("/100%25")).toBe("100%/index.html");
    expect(file("/search?q=../../x#..")).toBe("search/index.html");
    expect(file("/a.b/..c")).toBe("a.b/..c/index.html");
  });

  it("validates custom output paths: no traversal, no other root", () => {
    const out = (output: string) => outputFileFor({ path: "/x", output });
    expect(out("x.html")).toBe("x.html");
    expect(out("/pages/x.html")).toBe("pages/x.html");
    expect(out("pages\\x.html")).toBe("pages/x.html");
    // An empty output is "not set": the route-derived file is used.
    expect(out("")).toBe("x/index.html");
    for (const bad of ["../x.html", "a/../../x.html", "a\\..\\..\\x.html", "./", ".", "/", "//"]) {
      expect(() => out(bad), bad).toThrow(/unsafe output/);
    }
    for (const bad of ["C:\\Windows\\x.html", "c:/x.html", "D:x.html", "a\0b"]) {
      expect(() => out(bad), bad).toThrow(/must be a path relative/);
    }
  });

  it("refuses at the write boundary anything that resolves outside the dir, by segment", () => {
    expect(resolveInsideOutDir(posix, "/srv/out", "a/index.html")).toBe("/srv/out/a/index.html");
    expect(() => resolveInsideOutDir(posix, "/srv/out", "../x")).toThrow(/outside/);
    // A sibling sharing the prefix is outside, which a string-prefix test misses.
    expect(() => resolveInsideOutDir(posix, "/srv/out", "../out-evil/x")).toThrow(/outside/);
    expect(() => resolveInsideOutDir(posix, "/srv/out", "/etc/passwd")).toThrow(/outside/);
    expect(() => resolveInsideOutDir(posix, "/srv/out", ".")).toThrow(/outside/);
    expect(resolveInsideOutDir(win32, "C:\\out", "a\\index.html")).toBe("C:\\out\\a\\index.html");
    expect(() => resolveInsideOutDir(win32, "C:\\out", "D:\\x")).toThrow(/outside/);
    expect(() => resolveInsideOutDir(win32, "C:\\out", "..\\out-evil\\x")).toThrow(/outside/);
    expect(() => resolveInsideOutDir(win32, "C:\\out", "\\\\server\\share\\x")).toThrow(/outside/);
  });

  it("an unsafe route fails the run before anything is built, and writes nothing outside", async () => {
    const base = await mkdtemp(join(tmpdir(), "sibu-prerender-unsafe-"));
    try {
      const out = join(base, "dist");
      await mkdir(out);
      await expect(
        prerender({ routes: ["/ok", "/%2e%2e/outside"] }, { root: join(base, "no-such-root"), outDir: out }),
      ).rejects.toThrow(/unsafe route/);
      await expect(
        prerender({ routes: [{ path: "/x", output: "../outside.html" }] }, { root: base, outDir: out }),
      ).rejects.toThrow(/unsafe output/);
      expect((await readdir(base)).sort()).toEqual(["dist"]);
      expect(await readdir(out)).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
