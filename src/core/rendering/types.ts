export type NodeChild =
  | Node
  | Element
  | Text
  | Comment
  | string
  | number
  | boolean
  | (() => NodeChild)
  | null
  | undefined;
export type NodeChildren = NodeChild | NodeChild[] | NodeChild[][] | (() => NodeChild | NodeChild[]);
