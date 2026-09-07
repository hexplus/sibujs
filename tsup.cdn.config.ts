import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// ---------------------------------------------------------------------------
// CDN / IIFE builds.
//
// These are the ONLY outputs this package ships that a consumer cannot rebundle
// — a `<script src="…/cdn.global.js">` tag runs exactly the bytes published
// here. Every other entry point is handed to the consumer's bundler as ESM/CJS
// with `__SIBU_DEV__` left undefined ON PURPOSE, so that bundler decides the
// mode and folds the dev branches accordingly (see `src/core/dev.ts`).
//
// The CDN cannot delegate that decision, so it must be made here. Leaving it
// undefined meant `cdn.global.js` shipped every diagnostic string in the
// library as dead weight: with no define and no `process` in a browser, the dev
// gate resolves to `false` at runtime, so a no-build consumer downloaded and
// parsed thousands of bytes of warning text that could never print.
//
// Hence two artifacts, and they are NOT interchangeable:
//
//   dist/cdn.global.js      __SIBU_DEV__: false — production. Diagnostics are
//                           compiled out, not merely disabled.
//   dist/cdn.dev.global.js  __SIBU_DEV__: true  — development. Every warning is
//                           live with no build step, which is the whole point
//                           of having diagnostics in a no-build workflow.
//
// `tests/dist-artifacts.test.ts` asserts both properties against the real built
// files, because a define that silently stops being applied is exactly the kind
// of regression a source-level test cannot see.
// ---------------------------------------------------------------------------

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// NO `globalName`, deliberately — and this is a trap worth naming, because
// adding it back looks like an obvious improvement.
//
// `globalName: "Sibu"` makes esbuild emit `var Sibu = (() => { … })()`, and
// that assignment lands AFTER the module body has finished. `cdn.ts` installs a
// MERGED object (core + patterns + ui) from inside the body, so the wrapper
// would immediately overwrite it with the module's own export namespace —
// which is `export * from "./index"` and therefore core only. The merge would
// vanish with no error, no warning, and a bundle that still defines `Sibu`.
//
// `cdn.ts` assigns the global itself instead. `tests/dist-artifacts.test.ts`
// executes the built IIFE in a context where `window === globalThis`, the way a
// browser has it, and asserts the merged surface survives.
const shared = {
  format: ["iife"] as const,
  outDir: "dist",
  dts: false,
  minify: true,
};

export default defineConfig([
  {
    ...shared,
    // Object entry form: the KEY is the output basename, so this emits
    // `cdn.global.js` while the dev build below emits `cdn.dev.global.js` from
    // the same source.
    entry: { cdn: "cdn.ts" },
    define: {
      __SIBU_DEV__: "false",
      __SIBU_VERSION__: JSON.stringify(version),
    },
  },
  {
    ...shared,
    entry: { "cdn.dev": "cdn.ts" },
    define: {
      __SIBU_DEV__: "true",
      __SIBU_VERSION__: JSON.stringify(version),
    },
  },
  // core + patterns, for no-build pages that want `machine`. A separate file so
  // the default bundle above keeps its byte budget: patterns cost +13% gzip,
  // and most pages never call any of it.
  {
    ...shared,
    entry: { "cdn.full": "cdn.full.ts" },
    define: {
      __SIBU_DEV__: "false",
      __SIBU_VERSION__: JSON.stringify(version),
    },
  },
  {
    ...shared,
    entry: { "cdn.full.dev": "cdn.full.ts" },
    define: {
      __SIBU_DEV__: "true",
      __SIBU_VERSION__: JSON.stringify(version),
    },
  },
]);
