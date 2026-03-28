import type { NodeChildren } from "./types";

/**
 * Fragment groups multiple nodes without adding a wrapper DOM element.
 * Returns a DocumentFragment that can be appended to any parent.
 *
 * @example
 * ```ts
 * div({
 *   nodes: [
 *     Fragment([
 *       p({ nodes: "First" }),
 *       p({ nodes: "Second" }),
 *     ])
 *   ]
 * });
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
        frag.appendChild(resolveChild(nested));
      }
    } else {
      frag.appendChild(resolveChild(child));
    }
  }

  return frag;
}

function resolveChild(child: NodeChildren): Node {
  if (child == null) {
    return document.createTextNode("");
  }
  if (child instanceof Node) {
    return child;
  }
  if (typeof child === "function") {
    const result = (child as () => unknown)();
    if (result instanceof Node) return result;
    return document.createTextNode(String(result ?? ""));
  }
  return document.createTextNode(String(child));
}
