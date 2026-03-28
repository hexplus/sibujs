import { devWarn, isDev } from "../core/dev";
import type { NodeChild } from "../core/rendering/types";
import { track } from "./track";

const _isDev = isDev();

/**
 * Binds a reactive getter that returns NodeChild or NodeChild[] next to a placeholder comment.
 * Render errors are swallowed to preserve the last successful state.
 *
 * @param placeholder Anchor Comment node for insertion
 * @param getter Function returning NodeChild or NodeChild[] to render
 * @returns Teardown function to cancel the binding
 */
export function bindChildNode(placeholder: Comment, getter: () => NodeChild | NodeChild[]): () => void {
  let lastNodes: Node[] = [];

  function commit() {
    let result: NodeChild | NodeChild[];
    try {
      result = getter();
    } catch (err) {
      if (_isDev) devWarn(`bindChildNode: getter threw: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Remove previously inserted nodes
    for (let i = 0; i < lastNodes.length; i++) {
      const node = lastNodes[i];
      if (node.parentNode) node.parentNode.removeChild(node);
    }

    if (result == null || typeof result === "boolean") {
      lastNodes.length = 0;
      return;
    }

    const parent = placeholder.parentNode;
    if (!parent) {
      lastNodes.length = 0;
      return;
    }
    const anchor = placeholder.nextSibling;
    let count = 0;

    if (Array.isArray(result)) {
      // Reuse lastNodes array if large enough
      if (lastNodes.length < result.length) lastNodes = new Array(result.length);
      for (let i = 0; i < result.length; i++) {
        const item = result[i];
        if (item == null || typeof item === "boolean") continue;
        const node = item instanceof Node ? item : document.createTextNode(String(item));
        parent.insertBefore(node, anchor);
        lastNodes[count++] = node;
      }
    } else {
      if (lastNodes.length < 1) lastNodes = [null as unknown as Node];
      const node = result instanceof Node ? result : document.createTextNode(String(result));
      parent.insertBefore(node, anchor);
      lastNodes[count++] = node;
    }

    lastNodes.length = count;
  }

  // Initial render and reactive subscription
  return track(commit);
}
