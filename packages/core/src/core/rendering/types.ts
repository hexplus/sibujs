/**
 * Canonical disposer/teardown signature used across the framework.
 *
 * Returned by `effect()`, `track()`, widget `bind()` methods, and other
 * subscription/lifecycle helpers. All disposers MUST be idempotent — calling
 * twice should be a no-op rather than an error.
 */
export type Dispose = () => void;

/**
 * A getter that returns the CURRENT value each time it is called but does NOT
 * subscribe the caller to changes — reading it inside an effect/binding creates
 * no reactive dependency. This is deliberately distinct from `Accessor<T>`
 * (the reactive signal getter): a `StaticGetter` is used where the framework
 * hands you fresh-on-read data whose changes are driven by another mechanism.
 *
 * The `item`/`index` getters passed to an `each()` render callback are
 * `StaticGetter`s: they always return the row's current item/index, but a row's
 * content does NOT auto-re-render when the backing array changes. For reactive
 * per-row content, drive it from a per-item `signal`/`store`, not from `item()`.
 */
export type StaticGetter<T> = () => T;

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
