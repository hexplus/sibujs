import { devWarn, isDev } from "../dev";

const elementDisposers = new WeakMap<Node, Array<() => void>>();

// Dev-mode only: track active bindings to detect orphans.
// In production, _isDev is false and the counter is never touched.
const _isDev = isDev();
let activeBindingCount = 0;

/**
 * Register a teardown function for a DOM node.
 * When dispose(node) is called, all registered teardowns run.
 */
export function registerDisposer(node: Node, teardown: () => void): void {
  let disposers = elementDisposers.get(node);
  if (!disposers) {
    disposers = [];
    elementDisposers.set(node, disposers);
  }
  disposers.push(teardown);
  if (_isDev) activeBindingCount++;
}

/**
 * Run all registered teardowns for a node and its descendants,
 * cleaning up reactive subscriptions to prevent memory leaks.
 * Call this when removing elements from the DOM.
 *
 * Uses an iterative depth-first traversal to avoid stack overflow
 * on deeply nested DOM trees.
 */
export function dispose(node: Node): void {
  // Collect nodes in pre-order, then dispose in reverse (post-order)
  // to ensure children are disposed before parents.
  const stack: Node[] = [node];
  const order: Node[] = [];

  while (stack.length > 0) {
    const current = stack.pop()!;
    order.push(current);
    // Snapshot childNodes — it's a live NodeList. If a disposer mutates the
    // tree mid-traversal (removeChild/replaceChild), reading it lazily can
    // skip or duplicate children.
    const children = Array.from(current.childNodes);
    for (let i = 0; i < children.length; i++) {
      stack.push(children[i]);
    }
  }

  for (let i = order.length - 1; i >= 0; i--) {
    const current = order[i];
    const disposers = elementDisposers.get(current);
    if (disposers) {
      // Snapshot + delete BEFORE running so re-entrant dispose() on the
      // same node (e.g. parent disposer triggering child cleanup) doesn't
      // re-run these or land in an infinite cycle. Disposers may also push
      // new entries during execution; drain those after the snapshot.
      const snapshot = disposers.slice();
      elementDisposers.delete(current);
      if (_isDev) activeBindingCount -= snapshot.length;
      for (const d of snapshot) {
        try {
          d();
        } catch (err) {
          if (_isDev && typeof console !== "undefined") {
            console.warn("[SibuJS] Disposer threw during cleanup:", err);
          }
        }
      }
      // Drain any disposers added during execution above. Bounded by a
      // pass cap to prevent runaway re-entry.
      let extraPasses = 0;
      while (extraPasses++ < 8) {
        const added = elementDisposers.get(current);
        if (!added || added.length === 0) break;
        const moreSnapshot = added.slice();
        elementDisposers.delete(current);
        if (_isDev) activeBindingCount -= moreSnapshot.length;
        for (const d of moreSnapshot) {
          try {
            d();
          } catch (err) {
            if (_isDev && typeof console !== "undefined") {
              console.warn("[SibuJS] Disposer threw during cleanup:", err);
            }
          }
        }
      }
    }
  }
}

/**
 * Check for potential binding leaks. Returns the number of active DOM bindings.
 * In dev mode, logs a warning if the count exceeds the threshold.
 * In production, _isDev is false so the counter is always 0.
 */
export function checkLeaks(warnThreshold = 0): number {
  if (!_isDev) return 0;
  if (warnThreshold > 0 && activeBindingCount > warnThreshold) {
    devWarn(
      `checkLeaks: ${activeBindingCount} active DOM bindings detected. ` +
        `Expected ≤${warnThreshold}. This may indicate a component was removed from the DOM without calling dispose().`,
    );
  }
  return activeBindingCount;
}
