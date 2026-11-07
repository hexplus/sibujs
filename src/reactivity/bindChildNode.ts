import { DEV, devWarn } from "../core/dev";
import { reportError } from "../core/errors";
import { captureScope, inScope } from "../core/rendering/adoptScope";
import { dispose } from "../core/rendering/dispose";
import { captureFocusWithin, restoreFocusWithin } from "../core/rendering/focusPreservation";
import { liveRange, rangeStarts, registerRange } from "../core/rendering/range";
import type { NodeChild } from "../core/rendering/types";
import { reactiveBinding } from "./track";

/**
 * Binds a reactive getter that returns NodeChild or NodeChild[] next to a placeholder comment.
 * A throwing getter is contained — the last successful children stay on screen —
 * and the failure is reported through the central runtime error pipeline.
 *
 * @param placeholder Anchor Comment node for insertion
 * @param getter Function returning NodeChild or NodeChild[] to render
 * @param exposeNodes When true, the placeholder registers the sibling range it
 * renders (see `core/rendering/range.ts`). For a placeholder whose rendered nodes
 * are SIBLINGS in a range someone else releases node by node (a `Fragment`
 * child used as a `when` branch): a re-render puts new nodes in the live DOM,
 * outside the range that was recorded when the fragment was inserted.
 * @returns Teardown function to cancel the binding
 */
export function bindChildNode(
  placeholder: Comment,
  getter: () => NodeChild | NodeChild[],
  exposeNodes?: boolean,
): () => void {
  // The STARTS of the current run, not just what it returned: a fragment
  // empties itself on insertion, so it is recorded as its children, and a start
  // may render a sibling range of its own (an `each()` / directive anchor, a
  // `Fragment` function child) that grows after insertion. What the run
  // occupies is always read live from them (see `liveRange`).
  let lastNodes: Node[] = [];
  // The fragments the current run resolved: emptied, but each is a lifetime of
  // its own (cleanup registered on the fragment object), released with it.
  let lastFragments: Node[] = [];
  // A run is current from the moment it is built, BEFORE any outgoing cleanup
  // (or a custom element's reaction to an insertion) can run application code
  // that disposes this binding: the teardown then releases it, not yet placed.
  let committing = false;
  // Torn down: a commit that resumes after that adopts nothing.
  let stopped = false;
  // Every run builds its nodes in this child's own scope (adopting hydration).
  const scope = captureScope();

  function commit() {
    let result: NodeChild | NodeChild[];
    try {
      result = inScope(scope, getter);
    } catch (err) {
      // The getter is USER code. Keeping the previously rendered children is
      // the right containment, but reporting only under a dev flag made the
      // failure vanish entirely in production. Route it through the central
      // pipeline so an enclosing ErrorBoundary — or the runtime handler, or the
      // console — always sees it.
      reportError(err, { phase: "binding", name: "bindChildNode", node: placeholder });
      return;
    }

    // Everything the last run occupies NOW, read before anything is detached:
    // what its starts' ranges render (rows an `each()` added, a nested
    // directive's branch) is found only while they are siblings.
    const old = liveRange(lastNodes);

    // Snapshot focus BEFORE anything is detached — once a node is removed,
    // `document.activeElement` has already fallen back to <body> and there is
    // nothing left to identify. Returns null unless a field inside the subtree
    // we are about to discard actually held focus.
    const focused = captureFocusWithin(old);

    const items = result == null || typeof result === "boolean" ? [] : Array.isArray(result) ? result : [result];

    // Build the new start list: a fragment contributes its starts, recorded
    // before insertion empties it (see `rangeStarts`). Dedupe by reference so
    // a getter returning `[sharedEl, sharedEl]` doesn't desync DOM
    // (insertBefore moves the node, leaving only one in place but our list
    // recording two).
    const newNodes: Node[] = [];
    const fragments: Node[] = [];
    const seen = new Set<Node>();
    for (const item of items) {
      if (item == null || typeof item === "boolean") continue;
      const node = item instanceof Node ? item : document.createTextNode(String(item));
      if (node.nodeType === 11) fragments.push(node);
      for (const start of rangeStarts(node)) {
        if (seen.has(start)) {
          if (DEV) devWarn("bindChildNode: duplicate node reference in array — only the first occurrence is rendered.");
          continue;
        }
        seen.add(start);
        newNodes.push(start);
      }
    }

    // The getter disposed this binding: nothing is adopted, and the result is
    // released. Checked before anything else can return: the teardown may also
    // have detached the placeholder (an owner clearing its children).
    if (stopped) return release(newNodes, fragments);

    // Nothing to render (null / boolean) removes everything previously
    // rendered, attached or not; something to render needs the parent.
    const parent = placeholder.parentNode;
    if (!parent && items.length > 0) {
      lastNodes = [];
      return;
    }

    // Everything the new starts occupy, read before anything moves: a start
    // rendered again keeps its live range, a fragment's starts bring what they
    // render inside it, and a start already rendering elsewhere brings that.
    const incoming = liveRange(newNodes);
    const oldFragments = lastFragments;
    lastNodes = newNodes;
    lastFragments = fragments;
    committing = true;

    // Remove and DISPOSE old nodes that are not rendered again (Set
    // membership keeps this O(n+m)). Once detached they are no longer
    // reachable by an ancestor dispose-walk, so without disposing here their
    // reactive bindings/listeners leak (every sibling helper —
    // each/dynamic/directives — disposes on removal).
    const keep = new Set<Node>(incoming);
    for (const node of old) {
      if (keep.has(node)) continue;
      dispose(node);
      node.parentNode?.removeChild(node);
    }
    // Then the fragments not rendered again, once: emptied by now, so this
    // reaches only their own registrations.
    for (const frag of oldFragments) if (!fragments.includes(frag)) dispose(frag);

    // Place new nodes in order using a moving cursor anchored at the
    // placeholder. Each node is positioned immediately after the previously
    // placed one (or right after the placeholder for the first). A single
    // fixed `placeholder.nextSibling` anchor was WRONG: when nodes are reused
    // (already between the placeholder and the following sibling), inserting
    // every node before that fixed anchor reverses the tail ([A,B] -> [B,A]).
    // Something is placed only when there is a parent (checked above).
    // Each step runs application code (a cleanup above, a custom element's
    // `connectedCallback` here) that may dispose this binding, which released
    // the candidate: liveness is read again before every insertion.
    let prev: Node = placeholder;
    for (const node of incoming) {
      if (stopped) return;
      if (prev.nextSibling !== node) (parent as Node).insertBefore(node, prev.nextSibling);
      prev = node;
    }
    if (stopped) return;
    committing = false;

    // Placement is finished, so the rebuilt counterpart (if any) exists and can
    // be focused. A no-op unless the focused node was actually discarded —
    // and with nothing rendered in its place, this reports the loss rather
    // than repairing it.
    restoreFocusWithin(focused, incoming, "bindChildNode");
  }

  // Initial render and reactive subscription. `reactiveBinding` re-tracks
  // dependencies on every run, so a signal first read on a later run (e.g. a
  // conditional branch that only becomes live after a state change) is still
  // subscribed.
  // The placeholder is passed as the binding's error owner so a failure on a
  // LATER scheduled run can still be offered to the enclosing ErrorBoundary.
  // Structural, like `when`: the getter may replace the subtree it rendered,
  // and the subscribers that subtree created are owned by this binding.
  if (exposeNodes) {
    // Ends at the last start still next to the placeholder, or the range that
    // start renders (`rangeEnd` follows it from there).
    registerRange(placeholder, () => {
      for (let i = lastNodes.length; i--; ) if (lastNodes[i].parentNode === placeholder.parentNode) return lastNodes[i];
      return null;
    });
  }
  const stop = reactiveBinding(commit, placeholder, true);
  // Torn down with its owner. A tag factory owns the binding on the parent
  // element, whose dispose-walk has reached the rendered nodes by now. A
  // `Fragment` function child owns it on the placeholder, which a walk (or a
  // directive releasing its range) reaches BEFORE the siblings it renders:
  // those are released here first. Either way, children before the fragments'
  // own cleanup, and a commit in progress releases its candidate. Once only.
  return () => {
    if (stopped) return;
    stopped = true;
    stop();
    release(exposeNodes || committing ? lastNodes : [], lastFragments);
    lastNodes = lastFragments = [];
  };
}

/** Dispose what `starts` render now, then the fragments' own cleanup. */
function release(starts: Node[], fragments: Node[]): void {
  for (const node of liveRange(starts)) dispose(node);
  for (const frag of fragments) dispose(frag);
}
