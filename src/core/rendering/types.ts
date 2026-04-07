import type { Accessor } from "../signals/signal";

export type NodeChild =
  | Node
  | Element
  | Text
  | Comment
  | string
  | number
  | boolean
  | Accessor<NodeChild> // reactive signal getter — pass directly, do not call
  | (() => NodeChild) // explicit arrow wrapper — also reactive
  | null
  | undefined;
export type NodeChildren =
  | NodeChild
  | NodeChild[]
  | NodeChild[][]
  | Accessor<NodeChild | NodeChild[]>
  | (() => NodeChild | NodeChild[]);
