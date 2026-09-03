// @vitest-environment node
//
// esbuild refuses to run inside jsdom (its TextEncoder produces a Uint8Array
// from a different realm), and nothing in this file needs a DOM: it bundles
// source and inspects strings.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Tree-shaking evidence for the island / enhancement surface.
//
// The certification gate (`scripts/certify/bundler-matrix.mjs`) proves this
// against the PACKED TARBALL through four real bundlers, which is the stronger
// statement — but it needs a network install and does not run on an ordinary
// `npm test`. This runs on every suite, against the source, so a regression is
// caught the day it lands rather than at release time.
//
// Each subsystem is identified by a string literal only that subsystem emits,
// which survives minification verbatim.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..");

const MARKERS = {
  router: "sibujs.router.v1",
  query: "sibujs.query.cache.v1",
  islands: "sibujs.islands.registry.v1",
  i18n: "sibujs.i18n.v1",
  devtools: "sibujs.devtools.state.v1",
  dialog: "sibujs.dialog.v1",
  wasm: "sibujs.wasm.moduleCache.v1",
  "ssr-renderer": "data-sibu-suspense-id",
} as const;

async function bundle(entry: string): Promise<string> {
  const result = await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: "ts" },
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2020",
    write: false,
    define: { __SIBU_DEV__: "false", __SIBU_VERSION__: '"test"' },
  });
  return result.outputFiles[0].text;
}

function subsystemsIn(code: string): string[] {
  return Object.entries(MARKERS)
    .filter(([, marker]) => code.includes(marker))
    .map(([name]) => name);
}

describe("island / enhancement entry points stay tree-shakeable", () => {
  it("signal-only imports pull in nothing else — including islands", async () => {
    const code = await bundle(`
      export { signal } from "./src/core/signals/signal";
      export { effect } from "./src/core/signals/effect";
    `);
    expect(subsystemsIn(code)).toEqual([]);
  });

  it("external() does not drag in the island runtime", async () => {
    // The primitive lives in core signals precisely so that a page using it for
    // a canvas or an editor never pays for `enhance`/`mountIslands`.
    const code = await bundle(`
      export { signal } from "./src/core/signals/signal";
      export { effect } from "./src/core/signals/effect";
      export { external } from "./src/core/signals/signal";
    `);
    expect(subsystemsIn(code)).toEqual([]);
    expect(code).not.toContain("data-sibu-enhanced");
  });

  it("external() ships in the small shared core chunk, not the island chunk", async () => {
    // The property this replaced a size-delta assertion with, because it is the
    // one that bit: `external` used to live in its own module, which the build
    // could only place in the index-only chunk alongside `enhance`,
    // `mountIslands`, `mount` and `each`. Importing it from the package root
    // then produced a 77 KB bundle containing the whole island runtime instead
    // of a 12 KB one. Defining it beside `signal` — a module every entry point
    // shares — is what fixes that, and this pins it.
    if (!existsSync(resolve(ROOT, "dist/index.js"))) return; // build not run — consumption.test.ts owns that gate
    const code = await build({
      // A relative specifier resolved from the repo root, so no Windows path
      // separator ever has to survive being embedded in source.
      stdin: {
        contents:
          'import { external, signal } from "./dist/index.js";\n' +
          "const s = external(); s.track(); s.invalidate(); const [n] = signal(0); console.log(n());",
        resolveDir: ROOT,
        loader: "js",
      },
      bundle: true,
      minify: true,
      format: "esm",
      platform: "node",
      write: false,
    }).then((r) => r.outputFiles[0].text);

    expect(subsystemsIn(code)).toEqual([]);
    expect(code).not.toContain("data-sibu-enhanced");
    expect(code.length).toBeLessThan(30 * 1024);
  });

  it("importing islands does not pull in the router, data, i18n, wasm or devtools", async () => {
    const code = await bundle(`
      export { signal } from "./src/core/signals/signal";
      export { enhance } from "./src/platform/enhance";
      export { registerIsland, mountIslands } from "./src/platform/islands";
    `);
    expect(subsystemsIn(code)).toEqual(["islands"]);
  });

  it("ctx.each does not add a second binding engine — enhance stays one module", async () => {
    const withEach = await bundle(`
      export { enhance } from "./src/platform/enhance";
    `);
    // `each` is part of the same module as the helpers it delegates to, so it
    // cannot be shaken out independently; what matters is that the whole
    // enhancement surface stays small enough to ship on any page.
    expect(withEach.length).toBeLessThan(24 * 1024);
    expect(subsystemsIn(withEach)).toEqual([]);
  });

  it("the published entry points still exist and export the new API", async () => {
    // Guards against an export being added to `src/` but never surfaced.
    const index = await import("../index");
    expect(typeof index.external).toBe("function");
    expect(typeof index.enhance).toBe("function");
    expect(typeof index.registerIsland).toBe("function");
    expect(typeof index.mountIslands).toBe("function");
  });

  it("the built package re-exports external() and the each types", () => {
    // A text check rather than a dynamic import: importing `dist/` beside
    // `src/` in one process materialises two copies of the reactive runtime and
    // makes every later assertion in the file harder to trust.
    const js = resolve(ROOT, "dist/index.js");
    const dts = resolve(ROOT, "dist/index.d.ts");
    if (!existsSync(js) || !existsSync(dts)) return; // build not run — consumption.test.ts owns that gate
    // Substring, not a word-boundary regex: `\b` inside a template context is
    // exactly the trap `certify-declared-exports.test.ts` was written about.
    expect(readFileSync(js, "utf8")).toContain("external");
    const types = readFileSync(dts, "utf8");
    expect(types).toContain("ExternalSource");
    expect(types).toContain("EachBindings");
    expect(types).toContain("EachEventBindings");
  });
});
