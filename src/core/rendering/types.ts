/**
 * Canonical disposer/teardown signature used across the framework.
 *
 * Returned by `effect()`, `track()`, widget `bind()` methods, and other
 * subscription/lifecycle helpers. All disposers MUST be idempotent — calling
 * twice should be a no-op rather than an error.
 */
export type Dispose = () => void;

/**
 * A component: a function from its props to the DOM node it renders.
 *
 * `P` defaults to `void`, so a prop-less component is written and called
 * without arguments (`const App: Component = () => div("hi")`, then `App()`).
 * `R` is the root the component returns. It defaults to `Element`, so HTML and
 * SVG roots both fit; narrow it (`Component<Props, HTMLDivElement>`) to expose
 * the specific root type to callers.
 *
 * Every framework API that takes a component (`mount`, `lazy`, `Suspense`,
 * `Portal`, `registerComponent`, `DynamicComponent`, the HOC helpers) accepts
 * a `Component`, and every tag factory's result fits its return type.
 */
export type Component<P = void, R extends Node = Element> = (props: P) => R;

export type NodeChild =
  | Node
  | Element
  | Text
  | Comment
  | string
  | number
  | boolean
  // Reactive: pass an Accessor<NodeChild> directly or wrap in an arrow function.
  // Accessor<T> extends () => T so both forms are covered by this union member.
  | (() => NodeChild)
  | null
  | undefined;
export type NodeChildren = NodeChild | NodeChild[] | NodeChild[][] | (() => NodeChild | NodeChild[]);
