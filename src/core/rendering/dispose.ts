import { devWarn, isDev } from "../dev";

const elementDisposers = new WeakMap<Node, Array<() => void>>();

/**
 * Safety ceiling on the **total number of teardowns a single drain may execute**.
 *
 * A cleanup registering another cleanup is legitimate — a parent teardown
 * releasing a child, a lifecycle hook re-arming — so a drain keeps going until
 * the queue is stable, and ordinary finite chains of practical depth complete.
 *
 * The ceiling counts total teardown executions, not iterations over the queue.
 * Capping iterations abandons finite work purely for crossing the boundary,
 * which is indistinguishable from a leak; capping total work distinguishes
 * ordinary reentrant chains from typical runaway behaviour far better.
 *
 * It is nonetheless an **absolute work bound**, not a recursion detector. It
 * primarily protects against cleanup production that does not terminate — most
 * often recursive self-registration — but an exceptionally large *finite* chain
 * needing more than this many executions reaches it just the same. Either way
 * the condition is reported rather than silently swallowed, so bounded
 * protection never passes as completed cleanup — see {@link reportDrainRunaway}.
 */
export const MAX_DRAIN_TEARDOWNS = 10_000;

/**
 * Report a cleanup queue that did not stabilise within {@link MAX_DRAIN_TEARDOWNS}.
 *
 * Uses the existing console-based lifecycle convention; deliberately not a new
 * public error API. Reported unconditionally (not dev-gated) because it means
 * the framework stopped doing teardown work it was asked to do.
 */
export function reportDrainRunaway(label: string, executed: number, remaining: number): void {
  if (typeof console === "undefined") return;
  console.error(
    `[SibuJS ${label}] runaway cleanup: stopped after running ${executed} teardowns with ${remaining} still queued. ` +
      "Cleanup production did not stabilize before the teardown safety ceiling was reached — the remaining work was NOT run.",
    { executed, remaining },
  );
}

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
 * Drop a previously registered teardown for a node without running it.
 *
 * For owners that can be released independently of their node — an enhancement
 * disposed while its server markup stays on the page, and possibly re-enhanced
 * afterwards — the node-level entry would otherwise accumulate one dead closure
 * per generation, since `dispose()` is the only thing that clears the map.
 * The teardown is assumed to have already run (or to be deliberately abandoned);
 * this only releases the reference.
 */
export function unregisterDisposer(node: Node, teardown: () => void): void {
  const disposers = elementDisposers.get(node);
  if (!disposers) return;
  const index = disposers.indexOf(teardown);
  if (index === -1) return;
  disposers.splice(index, 1);
  if (_isDev) activeBindingCount--;
  if (disposers.length === 0) elementDisposers.delete(node);
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
    if (elementDisposers.has(current)) {
      // Drain to stability. A disposer may register another on the same node
      // (a parent teardown releasing a child, a lifecycle hook re-arming), and
      // that follow-up work is owed the same guarantee as the first batch — so
      // the loop runs until the queue is empty, bounded only by the safety
      // ceiling on total teardown executions (MAX_DRAIN_TEARDOWNS). That ceiling
      // is an absolute work bound: it primarily catches cleanup production that
      // does not terminate, but an exceptionally large finite chain reaches it
      // too, and either case is reported rather than silently dropped.
      let executed = 0;
      let runaway = false;

      while (!runaway) {
        const pending = elementDisposers.get(current);
        if (!pending || pending.length === 0) break;

        // Snapshot + delete BEFORE running so re-entrant dispose() on the
        // same node (e.g. parent disposer triggering child cleanup) doesn't
        // re-run these or land in an infinite cycle.
        const snapshot = pending.slice();
        elementDisposers.delete(current);
        if (_isDev) activeBindingCount -= snapshot.length;

        for (let i = 0; i < snapshot.length; i++) {
          if (executed >= MAX_DRAIN_TEARDOWNS) {
            // Put the untouched remainder back rather than dropping it: unlike
            // an enhancement's local queue, this one is node-keyed, so restored
            // entries stay reachable through a later dispose(node) and stay
            // visible to checkLeaks(). The runaway is still reported — bounded
            // protection must never look like completed cleanup.
            const rest = snapshot.slice(i);
            const added = elementDisposers.get(current);
            elementDisposers.set(current, added ? rest.concat(added) : rest);
            if (_isDev) activeBindingCount += rest.length;
            reportDrainRunaway("dispose", executed, rest.length + (added?.length ?? 0));
            runaway = true;
            break;
          }
          executed++;
          try {
            snapshot[i]();
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
 * Replace every child of `parent` with `next`, disposing the outgoing children
 * first.
 *
 * Native `replaceChildren()` detaches nodes without running SibuJS teardown, so
 * any reactive binding, lifecycle hook, or listener inside the removed subtree
 * survives as an unreachable zombie: it keeps firing against detached DOM and
 * is never collected. This helper enforces the disposal invariant — a
 * SibuJS-owned node removed permanently from the DOM is disposed exactly once.
 *
 * **A node in `next` is never disposed, even when it currently sits somewhere
 * inside an outgoing subtree.** Native `replaceChildren()` would move such a
 * node out of the content being replaced and keep it alive, and this helper
 * preserves those semantics: incoming nodes are detached *before* the outgoing
 * roots are disposed, so the dispose-walk cannot reach them. Everything else in
 * those outgoing subtrees is still torn down, so preserving one descendant does
 * not leak its former siblings or ancestors.
 */
export function replaceChildrenSafely(parent: ParentNode, ...next: Node[]): void {
  // Detach incoming nodes first. This is what keeps a node that is currently a
  // *descendant of an outgoing child* alive: once it is out of the tree, the
  // dispose() walk below cannot reach it. Doing this before the childNodes
  // snapshot also removes any incoming node that was already a direct child
  // from the outgoing set, so no separate keep-list is needed.
  for (let i = 0; i < next.length; i++) {
    const node = next[i];
    node.parentNode?.removeChild(node);
  }

  // Snapshot: childNodes is live and replaceChildren mutates it. Everything
  // still here is genuinely outgoing.
  const current = Array.from(parent.childNodes);
  for (let i = 0; i < current.length; i++) {
    dispose(current[i]);
  }

  parent.replaceChildren(...next);
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
