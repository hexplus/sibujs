// ---------------------------------------------------------------------------
// Sibu — CDN / IIFE bundle, core + patterns
//
// The same runtime as `cdn.global.js` with the `sibujs/patterns` entry point
// merged in. Load ONE of the two, never both.
//
// Usage:
//   <script src="https://unpkg.com/sibujs@latest/dist/cdn.full.global.js"></script>
//   <script>
//     const { signal, machine } = window.Sibu;
//   </script>
//
// WHY THIS IS A SEPARATE FILE. A <script> tag resolves no specifiers, so a
// no-build page had no way to reach `machine` and its siblings at all — they
// live behind `sibujs/patterns`, which only a bundler can resolve. Merging them
// into `cdn.global.js` closed that gap and charged every other no-build page
// +13% gzip for code it never calls. Two files costs one decision at the
// <script> tag and nothing at runtime.
//
// SPREAD ORDER IS LOAD-BEARING: core last, so core wins any collision. The
// namespace stays reachable as `Sibu.patterns` for anything that loses one.
// ---------------------------------------------------------------------------

import * as core from "./index";
import * as patterns from "./patterns";

// `globalThis` rather than `window`, so the bundle also self-registers in a
// worker. In a browser they are the same object. See `tsup.cdn.config.ts` for
// why this is written by hand instead of via esbuild's `globalName`.
if (typeof globalThis !== "undefined") {
  (globalThis as unknown as Record<string, unknown>).Sibu = { ...patterns, ...core, patterns };
}

// Also export everything for ESM consumers of this file.
//
// Only `./index`, deliberately. A second `export *` would make every name the
// two entries share ambiguous, and the ES module spec resolves that by
// excluding the name from BOTH. The global above is spread explicitly and has
// no such rule; that is where the merged surface lives.
export * from "./index";
