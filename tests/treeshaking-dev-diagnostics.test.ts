// @vitest-environment node
//
// esbuild refuses to run inside jsdom (its TextEncoder produces a Uint8Array
// from a different realm), and nothing here needs a DOM: it bundles source and
// inspects strings.

import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Dev diagnostics must COMPILE OUT of a production build.
//
// Every warning this library emits is a developer-experience feature paid for
// by consumers in bytes unless the gate that guards it can be statically folded
// away. `isDev()` is that gate, and the only thing a bundler can fold is the
// `__SIBU_DEV__` define — so `isDev()` must consult the define FIRST. If it
// leads with a `globalThis.__SIBU_DEV__` runtime lookup instead, nothing folds,
// every warning string ships, and each new diagnostic makes the production
// bundle bigger for no runtime benefit.
//
// Each diagnostic is identified by a string literal only that diagnostic emits,
// which survives minification verbatim.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..");

async function bundle(entry: string, dev: boolean): Promise<string> {
  const result = await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: "ts" },
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2020",
    write: false,
    define: { __SIBU_DEV__: String(dev), __SIBU_VERSION__: '"test"' },
  });
  return result.outputFiles[0].text;
}

// Markers for diagnostics reachable from the main entry point.
const CORE_MARKERS = {
  "lone-string class heuristic": "looks like a class list",
  "duplicate node in reactive array": "duplicate node reference",
  "dropped style declaration": "was dropped by the style sanitizer",
  "focus lost on rebuild": "discarded the focused element",
  "ambiguous focus identity": "several elements in the rebuilt subtree",
  "when() element-branch reuse": "branch was given as an element",
  // Emitted by tagFactory and the style sanitizer once their warning caches
  // fill up, so it belongs with the core diagnostics.
  "warning cap notice": "suppressing further",
  // Explanatory prose reached only from a warning callback. It leaked twice
  // while this work was in progress, because tree-shaking marks a TOP-LEVEL
  // binding live before the `__SIBU_DEV__` define folds its only reference
  // away — so dev-only text has to live INSIDE the callback, not in a constant
  // or helper the callback names. These two markers are the regression guard.
  "blocked-construct explanation": "exfiltration channel",
  "blocked-construct explanation (2)": "legacy scriptable filters",
} as const;

// NOTE: `[SibuJS]` is deliberately NOT a marker. `reportError` uses the same
// prefix for uncaught runtime errors, which must survive into production — so
// its presence proves nothing either way.

const PLUGIN_MARKERS = {
  "duplicate reactive runtime": "Multiple instances of the reactive runtime",
} as const;

describe("dev diagnostics are stripped from production builds", () => {
  it("emits every core diagnostic when __SIBU_DEV__ is true", async () => {
    const out = await bundle(`export * from "./index";`, true);
    for (const [name, marker] of Object.entries(CORE_MARKERS)) {
      expect(out.includes(marker), `${name}: expected marker ${JSON.stringify(marker)} in the DEV bundle`).toBe(true);
    }
  }, 60_000);

  it("strips every core diagnostic when __SIBU_DEV__ is false", async () => {
    const out = await bundle(`export * from "./index";`, false);
    for (const [name, marker] of Object.entries(CORE_MARKERS)) {
      expect(out.includes(marker), `${name}: marker ${JSON.stringify(marker)} leaked into the PROD bundle`).toBe(false);
    }
  }, 60_000);

  it("strips the duplicate-runtime warning from a production plugins build", async () => {
    const dev = await bundle(`export * from "./plugins";`, true);
    const prod = await bundle(`export * from "./plugins";`, false);
    for (const [name, marker] of Object.entries(PLUGIN_MARKERS)) {
      expect(dev.includes(marker), `${name}: expected marker in the DEV bundle`).toBe(true);
      expect(prod.includes(marker), `${name}: marker leaked into the PROD bundle`).toBe(false);
    }
  }, 60_000);

  it("keeps the globalThis override working when no define is present", async () => {
    // Without a `__SIBU_DEV__` define the library cannot know the mode at build
    // time, so it must fall back to the runtime global. Diagnostics stay in the
    // bundle here — that is the correct, honest outcome for an un-configured
    // build, and the escape hatch the test suite itself relies on.
    const result = await build({
      stdin: { contents: `export * from "./index";`, resolveDir: ROOT, loader: "ts" },
      bundle: true,
      minify: true,
      format: "esm",
      target: "es2020",
      write: false,
    });
    expect(result.outputFiles[0].text.includes("[SibuJS]")).toBe(true);
  }, 60_000);
});
