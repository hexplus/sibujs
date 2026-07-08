// ---------------------------------------------------------------------------
// sibujs — batteries-included entry point.
// The reactivity + rendering engine now lives in @sibujs/core and is
// re-exported here so `import { signal, div, mount } from "sibujs"` keeps
// working. Advanced features remain on subpaths: "sibujs/data",
// "sibujs/plugins", "sibujs/ssr", "sibujs/browser", etc.
// ---------------------------------------------------------------------------

// The full engine surface (signals, rendering, control flow, components,
// lifecycle, islands/enhancement, reactivity primitives).
export * from "@sibujs/core";

// Trusted HTML brand for opt-in unsafe-HTML APIs (compiled.staticTemplate,
// ssr.headExtra). Lives with the SSR renderer in this package.
export type { TrustedHTML } from "./src/platform/ssr";
export { trustHTML } from "./src/platform/ssr";
