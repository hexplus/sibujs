// ---------------------------------------------------------------------------
// Sibu — CDN / IIFE bundle
// Self-registering build for <script> tag usage without a bundler.
//
// Usage:
//   <script src="https://unpkg.com/sibujs@latest/dist/cdn.global.js"></script>
//   <script>
//     const { signal, effect, div, mount } = window.Sibu;
//   </script>
// ---------------------------------------------------------------------------

import * as core from "./index";
import * as patterns from "./patterns";

// Auto-register on window when loaded via <script> tag.
//
// `patterns` is here because a no-build consumer has no other way to reach it.
// It is an ordinary entry point that a bundler resolves from
// `sibujs/patterns`, but a <script> tag resolves nothing — so for the whole
// no-build audience `machine` and its siblings simply did not exist. Islands
// are the feature most often used without a bundler, which is where the gap bit.
//
// `sibujs/ui` is deliberately NOT here. It is the framework's UI-behaviour
// layer — form handling, a11y primitives, virtual lists, transitions, toasts —
// which most pages never touch, so merging it would make every no-build
// consumer download all of it to get `signal`. It also exports its own `dialog`
// and `form`, which are NOT the element tag factories of the same name, so a
// merge would put two unrelated meanings on one key. It stays bundler-only.
//
// Core is spread last so it wins any collision, and `patterns` stays reachable
// as a namespace.
//
// `globalThis` rather than `window`, so the bundle also self-registers in a
// worker. In a browser they are the same object. See `tsup.cdn.config.ts` for
// why this is written by hand instead of via esbuild's `globalName`.
if (typeof globalThis !== "undefined") {
  (globalThis as unknown as Record<string, unknown>).Sibu = { ...patterns, ...core, patterns };
}

// Also export everything for ESM consumers of this file.
//
// Only `./index`, deliberately. A second `export *` would make every name two
// entries share ambiguous, and the ES module spec resolves that by excluding
// the name from BOTH. The global above is spread explicitly and has no such
// rule; that is where the merged surface lives.
export * from "./index";
