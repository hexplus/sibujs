import { devAssert } from "../dev";
import { emitDevtools } from "../devtoolsHook";
import { reportError } from "../errors";
import { dispose, MAX_DRAIN_TEARDOWNS, reportDrainRunaway, withDisposerRollback } from "./dispose";

/**
 * Mounts a root component into a DOM element.
 * Supports both function components and pre-created nodes.
 *
 * A component function runs as a render transaction: if it throws — or the
 * append fails — every binding and listener it registered is released before
 * the error reaches the caller, so a failed mount leaves nothing subscribed.
 * A pre-built node belongs to its caller and is never rolled back.
 *
 * A `DocumentFragment` root (from `Fragment()`) empties itself into the
 * container, so the mount tracks the range it filled instead: `unmount()`
 * disposes and removes everything in that range, including nodes a reactive
 * child rendered after mounting.
 *
 * @param component Component function, or an already-built Element/Node.
 * @param container Element to mount into.
 * @returns `{ node, unmount }` — the live root node, and a teardown that
 * disposes the tree and removes it.
 */
export function mount(
  component: (() => Element) | Element | Node,
  container: Element | null,
): { node: Node; unmount: () => void } {
  if (!container) {
    throw new Error(
      "[SibuJS mount] container element not found. Make sure the DOM element exists before calling mount().",
    );
  }

  devAssert(
    typeof component === "function" || component instanceof Node,
    "mount: first argument must be a component function or a DOM Node.",
  );

  const now = (): number => (typeof performance !== "undefined" ? performance.now() : 0);
  const startTime = now();
  let range: { start: Comment; end: Comment } | null = null;
  const attach = (built: Node): void => {
    if (built instanceof DocumentFragment) {
      const start = document.createComment("");
      const end = document.createComment("");
      built.insertBefore(start, built.firstChild);
      built.appendChild(end);
      range = { start, end };
    }
    container.appendChild(built);
  };

  let node: Node;
  if (typeof component === "function") {
    node = withDisposerRollback(() => {
      const built = component();
      attach(built);
      return built;
    });
  } else {
    node = component;
    attach(node);
  }
  const duration = now() - startTime;

  // DevTools: emit app:init
  const hook = (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  if (hook) emitDevtools(hook, "app:init", { rootElement: node, container, duration });

  const mounted = range as { start: Comment; end: Comment } | null;
  return {
    node,
    unmount() {
      if (hook) emitDevtools(hook, "app:unmount", { rootElement: node });
      if (mounted) {
        unmountRange(mounted.start, mounted.end);
        return;
      }
      dispose(node);
      node.parentNode?.removeChild(node);
    },
  };
}

/**
 * Dispose and remove every node between `start` and `end`, then the markers.
 * Idempotent.
 *
 * The range is only trusted while both markers share a parent with `end` after
 * `start`. If outside code removed or moved a marker, "everything after
 * `start`" would include nodes this mount never owned, so nothing between them
 * is touched and the loss is reported.
 *
 * Nodes are drained one at a time rather than from a snapshot, re-checking the
 * markers each step, so a node a teardown inserts into the range is removed too.
 * The ceiling bounds only that growth: it is the range's size when unmounting
 * starts plus the same allowance as `dispose()`, so a large fragment is never
 * cut short. If it is reached anyway, the markers stay, keeping what is left
 * reachable by a later `unmount()`.
 */
function unmountRange(start: Comment, end: Comment): void {
  const parent = start.parentNode;
  // Both markers gone: already unmounted. Only the start gone: a lost marker,
  // reported below like any other; the `end` check makes this idempotent.
  if (!parent && !end.parentNode) return;
  let budget = MAX_DRAIN_TEARDOWNS;
  for (let n = start.nextSibling; n && n !== end; n = n.nextSibling) budget++;
  // `intact`: both markers still share the parent, with `end` after `start`.
  // The order test (4 = Node.DOCUMENT_POSITION_FOLLOWING) can walk the siblings,
  // so it runs once up front and again only when a marker's outer neighbour
  // changed — a marker cannot move without changing one unless it returns to
  // the same spot. Per-step it made unmounting quadratic in the range's size.
  // `start` is never its own sibling, so the first pass always runs the check.
  let before: Node | null = start;
  let after: Node | null = null;
  let intact = true;
  for (;;) {
    if (start.parentNode !== parent || end.parentNode !== parent) intact = false;
    else if (start.previousSibling !== before || end.nextSibling !== after) {
      before = start.previousSibling;
      after = end.nextSibling;
      intact = !!(start.compareDocumentPosition(end) & 4);
    }
    // While intact, `end` follows `start`, so `start.nextSibling` is never null.
    const n = start.nextSibling as ChildNode;
    if (!intact || n === end) break;
    if (budget-- <= 0) {
      reportDrainRunaway("mount", MAX_DRAIN_TEARDOWNS, 1);
      return;
    }
    dispose(n);
    // A teardown may have removed it already, or moved a marker — the next
    // check catches the latter before anything else goes. (Intact implies a
    // parent.)
    if (n.parentNode === parent) (parent as ParentNode).removeChild(n);
  }
  if (!intact) {
    // Outside code removed or reordered a marker; nodes past the point of
    // loss are left alone because this mount cannot tell whether it owns them.
    reportError(new Error("[SibuJS mount] fragment markers lost"), { phase: "cleanup", name: "mount" });
  }
  start.parentNode?.removeChild(start);
  end.parentNode?.removeChild(end);
}
