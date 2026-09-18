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

  for (const child of nodes) {
    if (child == null || typeof child === "boolean") continue;

    if (Array.isArray(child)) {
      for (const nested of child) {
        if (nested == null || typeof nested === "boolean") continue;
        appendChild(frag, nested);
      }
    } else {
      appendChild(frag, child);
    }
  }

  return frag;
}

function appendChild(frag: DocumentFragment, child: NodeChildren): void {
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
