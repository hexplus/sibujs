// ---------------------------------------------------------------------------
// Sibu — Server DOM
// A minimal DOM for server rendering without happy-dom or jsdom.
//   import { installServerDom } from "sibujs/ssr/dom";
// ---------------------------------------------------------------------------

export {
  createServerDocument,
  installServerDom,
  isServerDom,
  ServerDocument,
  ServerElement,
  ServerNode,
} from "./src/platform/serverDom";
