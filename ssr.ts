// ---------------------------------------------------------------------------
// Sibu — SSR
// Server-side rendering, hydration, and static site generation.
//   import { sbRenderToString, hydrate } from "sibu/ssr";
// ---------------------------------------------------------------------------

export * from "./src/platform/head";
export { ADOPT_ID_ATTR, type AdoptMismatch, type AdoptOptions, type AdoptResult } from "./src/platform/hydrateAdopt";
export * from "./src/platform/incrementalRegeneration";
export * from "./src/platform/microfrontend";
export * from "./src/platform/routeActions";
export * from "./src/platform/routeMiddleware";
export * from "./src/platform/scrollRestoration";
export * from "./src/platform/serviceWorker";
export * from "./src/platform/ssr";
export * from "./src/platform/renderHandler";
export * from "./src/platform/renderRoute";
export * from "./src/platform/ssrAsync";
export * from "./src/platform/staticSiteGenerator";
export * from "./src/platform/wasm";
export * from "./src/platform/worker";
export { isPrerendering, prerenderRoute, prerenderWait } from "./src/utils/prerenderHook";
