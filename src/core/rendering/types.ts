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
export type NodeChildren =
  | NodeChild
  | NodeChild[]
  | NodeChild[][]
  | (() => NodeChild | NodeChild[]);
