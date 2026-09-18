import { devAssert } from "../dev";
import { dispose, withDisposerRollback } from "./dispose";

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

  const startTime = typeof performance !== "undefined" ? performance.now() : 0;
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
  const duration = typeof performance !== "undefined" ? performance.now() - startTime : 0;

  // DevTools: emit app:init
  const hook = (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  if (hook) {
    hook.emit("app:init", { rootElement: node, container, duration });
  }

  const mounted = range as { start: Comment; end: Comment } | null;
  return {
    node,
    unmount() {
      if (hook) hook.emit("app:unmount", { rootElement: node });
      if (mounted) {
        unmountRange(mounted.start, mounted.end);
        return;
      }
      dispose(node);
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    },
  };
}

/** Dispose and remove `start`, `end` and every node between them. Idempotent. */
function unmountRange(start: Comment, end: Comment): void {
  const parent = start.parentNode;
  if (!parent) return;
  const nodes: Node[] = [];
  for (let n: Node | null = start; n !== null; n = n.nextSibling) {
    nodes.push(n);
    if (n === end) break;
  }
  for (const n of nodes) dispose(n);
  for (const n of nodes) n.parentNode?.removeChild(n);
}
