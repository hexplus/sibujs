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

// Auto-register on window when loaded via <script> tag.
//
// CORE ONLY, and that is a budget decision rather than an oversight. This is
// the file every no-build page downloads, so anything merged in is paid for by
// consumers who never call it. `patterns` cost +13% gzip on its own, which is
// why it lives in `cdn.full.global.js` instead: pages that want `machine` ask
// for it, and pages that want `signal` are not charged for it.
//
// `sibujs/ui` is in neither. It is the framework's UI-behaviour layer — form
// handling, a11y primitives, virtual lists, transitions, toasts — which most
// pages never touch, and it exports its own `dialog` and `form` that are NOT
// the element tag factories of the same name, so merging it would put two
// unrelated meanings on one key. It stays bundler-only.
//
// `globalThis` rather than `window`, so the bundle also self-registers in a
// worker. In a browser they are the same object. See `tsup.cdn.config.ts` for
// why this is written by hand instead of via esbuild's `globalName`.
if (typeof globalThis !== "undefined") {
  (globalThis as unknown as Record<string, unknown>).Sibu = { ...core };
}

// Also export everything for ESM consumers of this file.
//
// Only `./index`, deliberately. A second `export *` would make every name two
// entries share ambiguous, and the ES module spec resolves that by excluding
// the name from BOTH. The global above is spread explicitly and has no such
// rule; that is where the merged surface lives.
export * from "./index";
