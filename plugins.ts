// ---------------------------------------------------------------------------
// Sibu — Plugins
// Router, i18n, and other first-party plugins.
//   import { createRouter, sbSetLocale } from "sibu/plugins";
// ---------------------------------------------------------------------------

export * from "./src/plugins/ecosystem";
export * from "./src/plugins/i18n";
export * from "./src/plugins/modular";
export * from "./src/plugins/plugin";
export {
  type JsonLd,
  jsonLdScript,
  type ResolvedHeadTag,
  type ResolvedRouteHead,
  type RouteHead,
  type RouteHeadAlternate,
  type RouteHeadOpenGraph,
  type RouteHeadTwitter,
  type RouteHeadValue,
  type RouterHeadOptions,
  resolveRouteHead,
  routeHeadToHTML,
  serializeJsonLd,
} from "./src/plugins/routeHead";
export * from "./src/plugins/router";
export * from "./src/plugins/routerSSR";
export * from "./src/plugins/startup";
export * from "./src/plugins/versioning";
