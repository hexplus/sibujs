// ---------------------------------------------------------------------------
// SibuJS — Extras
// Convenience re-export of all advanced features. Prefer importing from
// specific subpaths for better tree-shaking:
//   import { query } from "sibujs/data";
//   import { media } from "sibujs/browser";
//   import { machine } from "sibujs/patterns";
//   import { transition } from "sibujs/motion";
// ---------------------------------------------------------------------------

// Domain subpaths (re-exported for convenience)
export * from "./data";
export * from "./browser";
export * from "./patterns";
export * from "./motion";

// UI utilities (not in a subpath yet)
export * from "./src/ui/form";
export * from "./src/ui/virtualList";
export * from "./src/ui/intersection";
export * from "./src/ui/inputMask";
export * from "./src/ui/a11y";
export * from "./src/ui/scopedStyle";
export * from "./src/ui/reactiveAttr";
export * from "./src/ui/dialog";
export * from "./src/ui/toast";
export * from "./src/ui/infiniteScroll";
export * from "./src/ui/pagination";
export * from "./src/ui/eventBus";

// Performance & scheduling
export * from "./src/performance/scheduler";
export * from "./src/performance/concurrent";
export * from "./src/performance/domRecycler";
export * from "./src/performance/bundleOptimize";
export * from "./src/performance/compiled";
export * from "./src/performance/normalize";
export * from "./src/performance/chunkLoader";

// Head & SSR
export * from "./src/platform/head";
export * from "./src/platform/ssr";

// Platform integration
export * from "./src/platform/customElement";
export * from "./src/platform/worker";
export * from "./src/platform/wasm";
export * from "./src/platform/microfrontend";
export * from "./src/platform/serviceWorker";
export * from "./src/platform/staticSiteGenerator";
export * from "./src/platform/incrementalRegeneration";
export * from "./src/platform/routeActions";
export * from "./src/platform/scrollRestoration";
export * from "./src/platform/routeMiddleware";

// Plugin system & extensibility
export * from "./src/plugins/plugin";
export * from "./src/plugins/modular";
export * from "./src/plugins/ecosystem";
export * from "./src/plugins/versioning";
export * from "./src/plugins/startup";

// Developer tools
export * from "./src/devtools/debug";
export * from "./src/devtools/devtools";
export * from "./src/devtools/hmr";
export * from "./src/devtools/sourceMaps";
export * from "./src/devtools/debugValue";
export * from "./src/devtools/componentProfiler";
export * from "./src/devtools/introspect";
export * from "./src/devtools/devtoolsOverlay";

// Design system widgets
export * from "./src/widgets/Combobox";
export * from "./src/widgets/Tabs";
export * from "./src/widgets/Accordion";
export * from "./src/widgets/Popover";
export * from "./src/widgets/Select";
export * from "./src/widgets/Tooltip";
export * from "./src/widgets/FileUpload";
export * from "./src/widgets/contentEditable";
export * from "./src/widgets/datePicker";

// Ecosystem — State management adapters
export * from "./src/ecosystem/adapters";

// Ecosystem — UI component library adapters
export * from "./src/ecosystem/ui";
