// ---------------------------------------------------------------------------
// Sibu — CDN / IIFE bundle
// Self-registering build for <script> tag usage without a bundler.
//
// Usage:
//   <script src="https://unpkg.com/sibujs@latest/dist/sibu.global.js"></script>
//   <script>
//     const { signal, effect, div, mount } = window.Sibu;
//   </script>
// ---------------------------------------------------------------------------

import * as core from "./index";

// Auto-register on window when loaded via <script> tag
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).Sibu = core;
}

// Also export everything for ESM consumers of this file
export * from "./index";
