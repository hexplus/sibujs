/**
 * Canonical disposer/teardown signature used across the framework.
 *
 * Returned by `effect()`, `track()`, widget `bind()` methods, and other
 * subscription/lifecycle helpers. All disposers MUST be idempotent — calling
 * twice should be a no-op rather than an error.
 */
export type Dispose = () => void;

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
