import { bindChildNode } from "../../reactivity/bindChildNode";
import { registerDisposer } from "./dispose";
import type { NodeChild, NodeChildren } from "./types";

/**
 * Fragment groups multiple nodes without adding a wrapper DOM element.
 * Returns a DocumentFragment that can be appended to any parent.
 *
 * A function child is reactive, exactly as it is inside a tag factory: it is
 * rendered after a placeholder comment and re-rendered when the signals it reads
 * change. The binding is owned by that placeholder, so disposing the parent the
 * fragment was appended to (or unmounting a mounted fragment) stops it.
 *
 * @example
 * ```ts
 * div([
 *   Fragment([
 *     p("First"),
 *     () => `Count: ${count()}`,
 *   ])
 * ]);
 * ```
 *
 * @param nodes Array of child nodes to include in the fragment
 * @returns A DocumentFragment containing all nodes
 */
export function Fragment(nodes: NodeChildren[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  appendChild(frag, nodes);
  return frag;
}

/**
 * Append one child — flattening arrays at any depth, since `NodeChildren` nests
 * (`NodeChild[][]`) and `Fragment()` takes an array of them. Skips `null`,
 * `undefined` and booleans, as a tag factory does.
 *
 * Deliberately not shared with the tag factories' child loop: that one is an
 * inlined hot path that registers bindings on its element, while a fragment
 * has to hand each binding to its own placeholder (the fragment empties itself
 * when appended).
 */
function appendChild(frag: DocumentFragment, child: unknown): void {
  if (child == null || typeof child === "boolean") return;
  if (Array.isArray(child)) {
    for (const nested of child) appendChild(frag, nested);
    return;
  }
  if (child instanceof Node) {
    frag.appendChild(child);
    return;
  }
  if (typeof child === "function") {
    const placeholder = document.createComment("");
    frag.appendChild(placeholder);
    registerDisposer(placeholder, bindChildNode(placeholder, child as () => NodeChild));
    return;
  }
  frag.appendChild(document.createTextNode(String(child)));
}
