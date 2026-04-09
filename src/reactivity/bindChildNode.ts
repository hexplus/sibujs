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

    if (result == null || typeof result === "boolean") {
      // Remove all previously inserted nodes
      for (let i = 0; i < lastNodes.length; i++) {
        const node = lastNodes[i];
        if (node.parentNode) node.parentNode.removeChild(node);
      }
      lastNodes.length = 0;
      return;
    }

    const parent = placeholder.parentNode;
    if (!parent) {
      lastNodes.length = 0;
      return;
    }

    // Build the new node list
    let newNodes: Node[];
    if (Array.isArray(result)) {
      newNodes = [];
      for (let i = 0; i < result.length; i++) {
        const item = result[i];
        if (item == null || typeof item === "boolean") continue;
        newNodes.push(item instanceof Node ? item : document.createTextNode(String(item)));
      }
    } else {
      const node = result instanceof Node ? result : document.createTextNode(String(result));
      newNodes = [node];
    }

    // Build a set of nodes that will be reused (present in both old and new lists)
    const reused: Set<Node> | undefined = lastNodes.length > 0 && newNodes.length > 0 ? new Set<Node>() : undefined;
    if (reused) {
      for (let i = 0; i < newNodes.length; i++) {
        for (let j = 0; j < lastNodes.length; j++) {
          if (newNodes[i] === lastNodes[j]) {
            reused.add(newNodes[i]);
            break;
          }
        }
      }
    }

    // Remove old nodes that are NOT reused
    for (let i = 0; i < lastNodes.length; i++) {
      const node = lastNodes[i];
      if (reused?.has(node)) continue;
      if (node.parentNode) node.parentNode.removeChild(node);
    }

    // Compute anchor AFTER removal so it's not stale
    const anchor = placeholder.nextSibling;

    // Insert new nodes in order, skipping nodes already in the correct position
    for (let i = 0; i < newNodes.length; i++) {
      const node = newNodes[i];
      if (reused?.has(node) && node.parentNode === parent) {
        // Reused node: only move if not already before the anchor
        if (node.nextSibling !== anchor) {
          parent.insertBefore(node, anchor);
        }
      } else {
        parent.insertBefore(node, anchor);
      }
    }

    lastNodes = newNodes;
  }

  // Initial render and reactive subscription
  return track(commit);
}
