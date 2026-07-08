import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Read the package version so the reactive runtime can stamp it onto the
// duplicate-instance registry (see @sibujs/core track.ts). `__SIBU_VERSION__`
// is a bundler define — under raw ESM / the test runner it is undefined and the
// runtime falls back to "dev".
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  define: {
    __SIBU_VERSION__: JSON.stringify(version),
  },
  // Disable code splitting: with multiple entries + splitting, esbuild hoists
  // `export * from "@sibujs/core"` into a side-effect-imported shared chunk and
  // drops the re-exported names from the entry. Self-contained entries keep the
  // star re-export intact so `import { signal } from "sibujs"` resolves.
  //
  // TRADEOFF: without splitting, code shared across the entry points is
  // duplicated in each output file, enlarging the *published* package (consumer
  // bundlers still tree-shake, so end-user bundle size is unaffected). A future
  // optimization: build only `index.ts` (the sole `export * from "@sibujs/core"`
  // entry) unsplit, and the remaining entries with splitting enabled.
  splitting: false,
  // Keep @sibujs/core EXTERNAL for the ESM/CJS module builds so `sibujs`
  // re-exports a SINGLE shared engine and never bundles its own copy — this is
  // what makes bundler dedup a packaging guarantee. The CDN/IIFE build uses a
  // separate config (tsup.cdn.config.ts) that inlines core instead.
  external: [/^@sibujs\/core(\/.*)?$/],
});
