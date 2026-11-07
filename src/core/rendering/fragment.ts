import { bindChildNode } from "../../reactivity/bindChildNode";
import { registerDisposer } from "./dispose";
import { requireDocument } from "./requireDocument";
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
 * A fragment is a valid `when()` / `match()` branch: the directive records the
 * fragment's nodes before inserting it (insertion empties a DocumentFragment)
 * and removes and disposes all of them on the next switch, including whatever
 * its reactive children have rendered since. Several sibling nodes need no
 * wrapper element (and no `display: contents` span).
 *
 * @example
 * ```ts
 * div([
 *   Fragment([
 *     p("First"),
 *     () => `Count: ${count()}`,
 *   ])
 * ]);
 *
 * when(() => editing(), () => Fragment([button("Save"), button("Cancel")]));
 * ```
 *
 * @param nodes Array of child nodes to include in the fragment
 * @returns A DocumentFragment containing all nodes
 */
export function Fragment(nodes: NodeChildren[]): DocumentFragment {
  requireDocument();
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
    // The rendered nodes are the placeholder's siblings, and a re-render puts
    // new ones in the live DOM, outside what was ever in the fragment. Exposed
    // so a directive releasing this fragment as a branch can find them.
    registerDisposer(placeholder, bindChildNode(placeholder, child as () => NodeChild, true));
    return;
  }
  frag.appendChild(document.createTextNode(String(child)));
}
