// @vitest-environment node
//
// esbuild refuses to run inside jsdom, and nothing here needs a DOM: it bundles
// the built package and inspects the output.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// What a consumer actually gets from the PUBLISHED build.
//
// `treeshaking-islands.test.ts` bundles source, and source shook correctly while
// the package did not: the build splits `dist/` into shared chunks, and a
// namespace object placed in one is a top-level call no consumer's bundler can
// remove. That retained the whole root surface for a three-import app, so these
// tests read `dist/`. `scripts/certify/bundler-matrix.mjs` makes the same point
// through the packed tarball and four bundlers at release time.
//
// The caps sit about 8% above the measured sizes. They are there to catch the
// namespace coming back (which adds about 25 KB), not to police every fix.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..");
const DIST = resolve(ROOT, "dist");
const INDEX = resolve(DIST, "index.js");
const BUILD = resolve(DIST, "build.js");
const ISLANDS_MARKER = "sibujs.islands.registry.v1";

const built = existsSync(INDEX) && existsSync(BUILD);
const onCI = !!process.env.CI;

async function consumer(names: string[]): Promise<{ text: string; gzip: number }> {
  const contents = `import { ${names.join(", ")} } from ${JSON.stringify(INDEX)}; globalThis.__used = [${names.join(", ")}];`;
  const result = await build({
    stdin: { contents, resolveDir: ROOT, loader: "js" },
    bundle: true,
    minify: true,
    format: "esm",
    write: false,
    define: { __SIBU_DEV__: "false" },
    logLevel: "silent",
  });
  const text = result.outputFiles[0].text;
  return { text, gzip: gzipSync(text, { level: 9 }).length };
}

describe.skipIf(!built && !onCI)("minimal imports from the built package", () => {
  it("keeps a signal-only import small", async () => {
    expect((await consumer(["signal"])).gzip).toBeLessThanOrEqual(5_500);
  });

  it("does not retain the root surface for a small DOM app", async () => {
    const { text, gzip } = await consumer(["signal", "div", "mount"]);
    expect(gzip, `gzip ${gzip} B`).toBeLessThanOrEqual(15_000);
    expect(text).not.toContain(ISLANDS_MARKER);
    // A tag factory the app never imported.
    expect(text).not.toContain('"figcaption"');
  });

  it("adds only the list renderer for a keyed list", async () => {
    const { text, gzip } = await consumer(["signal", "each", "li", "ul", "mount"]);
    expect(gzip, `gzip ${gzip} B`).toBeLessThanOrEqual(16_500);
    expect(text).not.toContain(ISLANDS_MARKER);
  });

  it("emits no namespace object into a shared chunk", () => {
    const offenders = readdirSync(DIST)
      .filter((name) => /^chunk-.*\.js$/.test(name))
      .filter((name) => /^__export\(/m.test(readFileSync(resolve(DIST, name), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe.skipIf(!built && !onCI)("registerGlobal from the built package", () => {
  const g = globalThis as unknown as { window?: Record<string, unknown> };
  const hadWindow = "window" in g;
  const previous = g.window;

  afterEach(() => {
    if (hadWindow) g.window = previous;
    else delete g.window;
  });

  it("still publishes every root export", async () => {
    const root = (await import(/* @vite-ignore */ pathToFileURL(INDEX).href)) as Record<string, unknown>;
    const tools = (await import(/* @vite-ignore */ pathToFileURL(BUILD).href)) as { registerGlobal: () => void };
    g.window = {};

    tools.registerGlobal();

    const published = g.window.Sibu as Record<string, unknown>;
    expect(Object.keys(published).sort()).toEqual(Object.keys(root).sort());
    expect(published.mount).toBe(root.mount);
  });
});
