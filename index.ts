// ---------------------------------------------------------------------------
// Sibu — Core
// This is the lean core of the framework. For advanced features (state
// machines, time-travel, virtual lists, etc.), import from "sibu/extras".
// For routing and i18n, import from "sibu/plugins".
// For build tooling, import from "sibu/build".
// ---------------------------------------------------------------------------

// Components
export * from "./src/components/ErrorBoundary";
export * from "./src/components/ErrorDisplay";
export * from "./src/components/Loading";
export * from "./src/core/rendering/action";
export * from "./src/core/rendering/catch";
export * from "./src/core/rendering/context";
export * from "./src/core/rendering/createId";
export * from "./src/core/rendering/directives";
// Disposal (reactive binding cleanup)
export * from "./src/core/rendering/dispose";
export * from "./src/core/rendering/dynamic";
export * from "./src/core/rendering/each";
export * from "./src/core/rendering/fragment";
// htm — tagged template literal for HTML-like syntax (no compiler)
export { html } from "./src/core/rendering/htm";
// HTML tag factories (including SVG with correct namespace)
export * from "./src/core/rendering/html";
export * from "./src/core/rendering/keepAlive";
export type { SuspenseProps } from "./src/core/rendering/lazy";
// Lazy loading & Suspense
export { lazy, Suspense, takePendingError } from "./src/core/rendering/lazy";
// Lifecycle & context
export * from "./src/core/rendering/lifecycle";
// Mounting & rendering
export * from "./src/core/rendering/mount";
export * from "./src/core/rendering/portal";
export * from "./src/core/rendering/slots";
export type { TagProps } from "./src/core/rendering/tagFactory";
export { SVG_NS, tagFactory } from "./src/core/rendering/tagFactory";
// Per-element typed prop interfaces for common form/media/link elements
export type {
  AnchorProps,
  AudioProps,
  ButtonProps,
  FormProps,
  ImgProps,
  InputProps,
  InputType,
  LabelProps,
  MediaProps,
  OptionProps,
  SelectProps,
  TextareaProps,
  TypedTagFunction,
  VideoProps,
} from "./src/core/rendering/tagPropTypes";
// Rendering types
export type { Dispose, NodeChild, NodeChildren } from "./src/core/rendering/types";
export * from "./src/core/signals/array";
export * from "./src/core/signals/asyncDerived";
export * from "./src/core/signals/deepSignal";
export * from "./src/core/signals/derived";
export * from "./src/core/signals/effect";
export * from "./src/core/signals/ref";
// Signals — state & reactivity
export * from "./src/core/signals/signal";
export * from "./src/core/signals/store";
export * from "./src/core/signals/watch";
export * from "./src/core/signals/writable";
// SSR context
export * from "./src/core/ssr-context";
export * from "./src/core/strict";
// Islands & progressive enhancement — attach fine-grained reactivity to
// existing (server-rendered) HTML with no build step. The third rendering mode
// alongside mount() and hydrate().
export * from "./src/platform/enhance";
export * from "./src/platform/islands";
export type { TrustedHTML } from "./src/platform/ssr";
// Trusted HTML brand for opt-in unsafe-HTML APIs (compiled.staticTemplate, ssr.headExtra)
export { trustHTML } from "./src/platform/ssr";
// Reactivity primitives
export * from "./src/reactivity/batch";
export { bindDynamic } from "./src/reactivity/bindAttribute";
export * from "./src/reactivity/concurrent";
export * from "./src/reactivity/nextTick";
export { retrack, setMaxDrainIterations, untracked } from "./src/reactivity/track";
