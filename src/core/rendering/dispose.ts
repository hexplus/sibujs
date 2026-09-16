import { DEV, devWarn } from "../dev";
import { reportError } from "../errors";

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
let activeBindingCount = 0;

/**
 * One open render transaction's registration record. Frames are identities, not
 * just arrays: a subscriber created inside a transaction keeps a reference to
 * its frame, so its later re-runs register into that transaction (and are rolled
 * back with it) while everything else stays out. A closed frame accepts nothing.
 *
 * @internal
 */
export interface DisposerCapture {
  entries: [Node, () => void][];
  closed: boolean;
  /**
   * Set when a transaction SUCCEEDS inside another: its registrations were
   * handed to the enclosing one, so a subscriber it created keeps registering
   * there. Absent after a rollback (that transaction owns nothing any more) and
   * at the outermost level (later re-runs are captured by nobody).
   */
  forwardTo?: DisposerCapture;
}

/** The frame a capture stands for now: itself, or whoever inherited it. */
function resolveCapture(capture: DisposerCapture | null | undefined): DisposerCapture | null {
  let frame = capture;
  while (frame?.closed) frame = frame.forwardTo;
  return frame ?? null;
}

// Open captures, innermost last. A `null` frame suppresses capturing entirely.
const registrationCaptures: (DisposerCapture | null)[] = [];

/** The capture a subscriber created right now belongs to. @internal */
export function currentDisposerCapture(): DisposerCapture | null {
  return resolveCapture(registrationCaptures[registrationCaptures.length - 1]);
}

/**
 * Make `capture` (or no capture at all) the active one for the code that
 * follows, and report whether a frame was pushed. The reactive runtime brackets
 * every subscriber re-run with this: a re-run registers into the transaction
 * that created the subscriber, and an unrelated subscriber's registrations do
 * not leak into whatever transaction happens to be open.
 *
 * @internal
 */
export function beginDisposerCapture(capture: DisposerCapture | null): boolean {
  // Nothing to isolate: no transaction is open and the subscriber owns none.
  if (capture === null && registrationCaptures.length === 0) return false;
  // A closed frame resolves to whoever inherited its work (see forwardTo), so a
  // subscriber created by a successful nested transaction keeps registering into
  // the enclosing one until that finishes too.
  registrationCaptures.push(resolveCapture(capture));
  return true;
}

/** Undo a {@link beginDisposerCapture} that returned `true`. @internal */
export function endDisposerCapture(): void {
  registrationCaptures.pop();
}

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
  if (DEV) activeBindingCount++;
  const capture = resolveCapture(registrationCaptures[registrationCaptures.length - 1]);
  if (capture) capture.entries.push([node, teardown]);
}

/**
 * Run `build` as a render transaction.
 *
 * Every disposer registered while it runs is recorded. If `build` throws, those
 * registrations — and only those — are run and unregistered in reverse order,
 * then the error is rethrown; ownership that existed before the attempt (a host
 * element's own disposers, say) is untouched. This is what lets a failed
 * rebuild release the bindings and listeners it created before throwing, even
 * though the half-built nodes were never returned to the caller.
 *
 * On success the registrations stay, and an enclosing transaction inherits
 * them, so an outer failure rolls back nested successful work too.
 *
 * @internal
 */
export function withDisposerRollback<T>(build: () => T): T {
  const frame: DisposerCapture = { entries: [], closed: false };
  const captured = frame.entries;
  registrationCaptures.push(frame);
  let result: T;
  try {
    result = build();
  } catch (err) {
    // The capture stays open while rolling back: a teardown that registers more
    // cleanup lands in `captured` and is drained too (newest first), bounded by
    // the same ceiling as dispose(). Popping it first left those registrations
    // attached to nodes the failed render never returned.
    let executed = 0;
    try {
      while (captured.length > 0) {
        if (executed >= MAX_DRAIN_TEARDOWNS) {
          // Leave the remainder registered (reachable via dispose/checkLeaks).
          reportDrainRunaway("rollback", executed, captured.length);
          break;
        }
        const [node, teardown] = captured.pop()!;
        // Only teardowns still registered are owed a run: one already executed
        // (or removed) by a dispose() during the build must not run twice.
        if (!unregisterDisposer(node, teardown)) continue;
        executed++;
        try {
          teardown();
        } catch (cleanupErr) {
          reportError(cleanupErr, { phase: "cleanup", name: "disposer" });
        }
      }
    } finally {
      frame.closed = true;
      // Whatever the ceiling left behind stays REGISTERED (reachable through
      // dispose()), but this frame stops referencing it.
      captured.length = 0;
      registrationCaptures.pop();
    }
    throw err;
  }
  frame.closed = true;
  registrationCaptures.pop();
  const parent = resolveCapture(registrationCaptures[registrationCaptures.length - 1]);
  if (parent) {
    // Hand up only registrations that are still live; ones a dispose() already
    // ran are not the enclosing transaction's to roll back.
    for (const entry of captured) {
      if (elementDisposers.get(entry[0])?.includes(entry[1])) parent.entries.push(entry);
    }
    // Subscribers created by this transaction now belong to the enclosing one.
    frame.forwardTo = parent;
  }
  // A subscriber created here keeps a reference to this frame for its whole
  // life, so the frame must not keep the transaction's nodes and teardowns
  // alive: the live ones now belong to the parent (or to nobody), and the
  // disposed ones are gone. Registrations made later resolve through
  // `forwardTo`, never into this array.
  captured.length = 0;
  return result;
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
export function unregisterDisposer(node: Node, teardown: () => void): boolean {
  const disposers = elementDisposers.get(node);
  if (!disposers) return false;
  const index = disposers.indexOf(teardown);
  if (index === -1) return false;
  disposers.splice(index, 1);
  if (DEV) activeBindingCount--;
  if (disposers.length === 0) elementDisposers.delete(node);
  return true;
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
        if (DEV) activeBindingCount -= snapshot.length;

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
            if (DEV) activeBindingCount += rest.length;
            reportDrainRunaway("dispose", executed, rest.length + (added?.length ?? 0));
            runaway = true;
            break;
          }
          executed++;
          try {
            snapshot[i]();
          } catch (err) {
            // A disposer is user teardown. Containment is deliberate — the
            // remaining disposers must still run — but gating the report on dev
            // mode meant a leaking teardown was invisible in production.
            reportError(err, { phase: "cleanup", name: "disposer" });
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
 * In production, DEV is false so the counter is always 0.
 *
 * @returns Diagnostic counts of nodes still holding registered disposers.
 */
export function checkLeaks(warnThreshold = 0): number {
  if (!DEV) return 0;
  if (warnThreshold > 0 && activeBindingCount > warnThreshold) {
    devWarn(
      `checkLeaks: ${activeBindingCount} active DOM bindings detected. ` +
        `Expected ≤${warnThreshold}. This may indicate a component was removed from the DOM without calling dispose().`,
    );
  }
  return activeBindingCount;
}
