import { bindOwnerScope } from "../../reactivity/track";
import { reportError } from "../errors";
import { dispose, registerDisposer } from "./dispose";

/**
 * Portal renders nodes into a DOM node outside the parent component hierarchy.
 * Useful for modals, tooltips, dropdowns, and overlays.
 *
 * Cleanup integrates with `dispose()` / `registerDisposer()` so portals
 * are properly torn down when the anchor is disposed by `when()`, `match()`,
 * `each()`, or manual `dispose(anchor)`.
 *
 * @param nodes Function that returns the content to render — any element,
 * HTML or SVG (a `Component` fits)
 * @param target Target DOM element (defaults to document.body)
 * @returns A Comment anchor node in the original position
 *
 * @example
 * ```ts
 * // Render modal at document.body
 * Portal(() => div("modal", "Modal content"));
 *
 * // Render into specific container
 * const overlay = document.getElementById("overlay-root")!;
 * Portal(() => div("Tooltip"), overlay);
 * ```
 */
export function Portal(nodes: () => Element, target?: Element): Comment {
  const anchor = document.createComment("portal");
  const container = target || document.body;
  let portalContent: Element | null = null;
  let disposed = false;

  // Portal content is built in a microtask; it keeps the owner scope of the
  // component that created the portal.
  const renderContent = bindOwnerScope(() => {
    // If the anchor was disposed before this microtask ran, skip append
    // entirely — otherwise portalContent leaks into the target DOM.
    if (disposed) return;
    try {
      portalContent = nodes();
      container.appendChild(portalContent);
    } catch (err) {
      // Single path: `reportError` offers the error to an enclosing boundary
      // and, only if none claims it, to the runtime handler / console. The old
      // code logged unconditionally AND dispatched, so a boundary-handled
      // portal failure was still reported a second time to the console.
      //
      // Deferred one microtask so the anchor is linked to its parent before
      // boundary lookup walks the parentNode chain.
      queueMicrotask(() => {
        reportError(err, {
          phase: "render",
          name: "Portal",
          node: anchor.parentNode ? anchor : undefined,
        });
      });
    }
  });
  queueMicrotask(renderContent);

  // Primary cleanup: registerDisposer on the anchor so `dispose()`,
  // `when()`, `match()`, and `each()` all clean up portal content.
  registerDisposer(anchor, () => {
    disposed = true;
    if (portalContent) {
      dispose(portalContent);
      portalContent.remove();
      portalContent = null;
    }
  });

  return anchor;
}
