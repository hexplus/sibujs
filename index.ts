// ---------------------------------------------------------------------------
// Sibu — Core
// This is the lean core of the framework. For advanced features (state
// machines, time-travel, virtual lists, etc.), import from "sibu/extras".
// For routing and i18n, import from "sibu/plugins".
// For build tooling, import from "sibu/build".
// ---------------------------------------------------------------------------

// HTML tag factories (including SVG with correct namespace)
export * from "./src/core/rendering/html";
export { tagFactory, SVG_NS } from "./src/core/rendering/tagFactory";
export type { TagProps } from "./src/core/rendering/tagFactory";
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

// htm — tagged template literal for HTML-like syntax (no compiler)
export { html } from "./src/core/rendering/htm";

// Rendering types
export type { Dispose, NodeChild, NodeChildren } from "./src/core/rendering/types";

// Mounting & rendering
export * from "./src/core/rendering/mount";
export * from "./src/core/rendering/each";
export * from "./src/core/rendering/fragment";
export * from "./src/core/rendering/portal";
export * from "./src/core/rendering/dynamic";
export * from "./src/core/rendering/slots";
export * from "./src/core/rendering/directives";
export * from "./src/core/rendering/keepAlive";
export * from "./src/core/rendering/action";
export * from "./src/core/rendering/catch";
export * from "./src/core/rendering/createId";

// Disposal (reactive binding cleanup)
export * from "./src/core/rendering/dispose";

// Signals — state & reactivity
export * from "./src/core/signals/signal";
export * from "./src/core/signals/effect";
export * from "./src/core/signals/derived";
export * from "./src/core/signals/watch";
export * from "./src/core/signals/store";
export * from "./src/core/signals/ref";
export * from "./src/core/signals/array";
export * from "./src/core/signals/deepSignal";
export * from "./src/core/signals/writable";
export * from "./src/core/signals/asyncDerived";

// Lifecycle & context
export * from "./src/core/rendering/lifecycle";
export * from "./src/core/rendering/context";
export * from "./src/core/strict";

// SSR context
export * from "./src/core/ssr-context";

// Reactivity primitives
export * from "./src/reactivity/batch";
export * from "./src/reactivity/nextTick";
export * from "./src/reactivity/concurrent";
export { untracked, retrack, setMaxDrainIterations } from "./src/reactivity/track";
export { bindDynamic } from "./src/reactivity/bindAttribute";

// Lazy loading & Suspense
export { lazy, Suspense, takePendingError } from "./src/core/rendering/lazy";
export type { SuspenseProps } from "./src/core/rendering/lazy";

// Trusted HTML brand for opt-in unsafe-HTML APIs (compiled.staticTemplate, ssr.headExtra)
export { trustHTML } from "./src/platform/ssr";
export type { TrustedHTML } from "./src/platform/ssr";

// Components
export * from "./src/components/ErrorBoundary";
export * from "./src/components/ErrorDisplay";
export * from "./src/components/Loading";
