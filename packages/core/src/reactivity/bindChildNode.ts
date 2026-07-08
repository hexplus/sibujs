import { devWarn, isDev } from "../core/dev";
import { dispose } from "../core/rendering/dispose";
import type { NodeChild } from "../core/rendering/types";
import { reactiveBinding } from "./track";

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
      // Remove and DISPOSE all previously inserted nodes. Once detached they
      // are no longer reachable by an ancestor dispose-walk, so without
      // disposing here their reactive bindings/listeners leak (every sibling
      // helper — each/dynamic/directives — disposes on removal).
      for (let i = 0; i < lastNodes.length; i++) {
        const node = lastNodes[i];
        dispose(node);
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

    // Build the new node list. Dedupe by reference so a getter returning
    // `[sharedEl, sharedEl]` doesn't desync DOM (insertBefore moves the
    // node, leaving only one in place but our list recording two).
    let newNodes: Node[];
    if (Array.isArray(result)) {
      newNodes = [];
      const seen = new Set<Node>();
      for (let i = 0; i < result.length; i++) {
        const item = result[i];
        if (item == null || typeof item === "boolean") continue;
        const node = item instanceof Node ? item : document.createTextNode(String(item));
        if (seen.has(node)) {
          if (_isDev)
            devWarn("bindChildNode: duplicate node reference in array — only the first occurrence is rendered.");
          continue;
        }
        seen.add(node);
        newNodes.push(node);
      }
    } else {
      const node = result instanceof Node ? result : document.createTextNode(String(result));
      newNodes = [node];
    }

    // Build a set of nodes that will be reused (present in both old and new lists).
    // Use Set membership for O(n+m) instead of the previous O(n*m) nested scan.
    let reused: Set<Node> | undefined;
    if (lastNodes.length > 0 && newNodes.length > 0) {
      const lastSet = new Set<Node>(lastNodes);
      reused = new Set<Node>();
      for (let i = 0; i < newNodes.length; i++) {
        if (lastSet.has(newNodes[i])) reused.add(newNodes[i]);
      }
    }

    // Remove (and dispose) old nodes that are NOT reused.
    for (let i = 0; i < lastNodes.length; i++) {
      const node = lastNodes[i];
      if (reused?.has(node)) continue;
      dispose(node);
      if (node.parentNode) node.parentNode.removeChild(node);
    }

    // Place new nodes in order using a moving cursor anchored at the
    // placeholder. Each node is positioned immediately after the previously
    // placed one (or right after the placeholder for the first). A single
    // fixed `placeholder.nextSibling` anchor was WRONG: when nodes are reused
    // (already between the placeholder and the following sibling), inserting
    // every node before that fixed anchor reverses the tail ([A,B] -> [B,A]).
    let prev: Node = placeholder;
    for (let i = 0; i < newNodes.length; i++) {
      const node = newNodes[i];
      if (prev.nextSibling !== node) {
        parent.insertBefore(node, prev.nextSibling);
      }
      prev = node;
    }

    lastNodes = newNodes;
  }

  // Initial render and reactive subscription. `reactiveBinding` re-tracks
  // dependencies on every run, so a signal first read on a later run (e.g. a
  // conditional branch that only becomes live after a state change) is still
  // subscribed.
  return reactiveBinding(commit);
}
