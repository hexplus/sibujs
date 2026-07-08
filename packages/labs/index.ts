// ---------------------------------------------------------------------------
// @sibujs/labs — opt-in long-tail modules.
// Convenience aggregate re-export of every labs subpath. Prefer importing from
// specific subpaths for better tree-shaking:
//   import { media } from "@sibujs/labs/browser";
//   import { machine } from "@sibujs/labs/patterns";
//   import { transition } from "@sibujs/labs/motion";
//
// These modules carry a lower support guarantee than @sibujs/core and sibujs.
// ---------------------------------------------------------------------------

export * from "./browser";
export * from "./widgets";
export * from "./patterns";
export * from "./ecosystem";
export * from "./performance";
export * from "./devtools";
export * from "./motion";
