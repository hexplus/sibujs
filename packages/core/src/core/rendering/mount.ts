import { devAssert } from "../dev";
import { dispose } from "./dispose";

/**
 * Mounts a root component into a DOM element.
 * Supports both function components and pre-created HTMLElements.
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
  const node = typeof component === "function" ? component() : component;
  const duration = typeof performance !== "undefined" ? performance.now() - startTime : 0;

  container.appendChild(node);

  // DevTools: emit app:init
  const hook = (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  if (hook) {
    hook.emit("app:init", { rootElement: node, container, duration });
  }

  return {
    node,
    unmount() {
      if (hook) hook.emit("app:unmount", { rootElement: node });
      dispose(node);
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    },
  };
}
