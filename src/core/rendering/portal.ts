import { dispose, registerDisposer } from "./dispose";

/**
 * Portal renders nodes into a DOM node outside the parent component hierarchy.
 * Useful for modals, tooltips, dropdowns, and overlays.
 *
 * Cleanup integrates with `dispose()` / `registerDisposer()` so portals
 * are properly torn down when the anchor is disposed by `when()`, `match()`,
 * `each()`, or manual `dispose(anchor)`.
 *
 * @param nodes Function that returns the content to render
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
export function Portal(nodes: () => HTMLElement, target?: HTMLElement): Comment {
  const anchor = document.createComment("portal");
  const container = target || document.body;
  let portalContent: HTMLElement | null = null;
  let disposed = false;

  queueMicrotask(() => {
    // If the anchor was disposed before this microtask ran, skip append
    // entirely — otherwise portalContent leaks into the target DOM.
    if (disposed) return;
    try {
      portalContent = nodes();
      container.appendChild(portalContent);
    } catch (err) {
      if (typeof console !== "undefined") {
        console.error("[Portal] Render error:", err);
      }
      // Dispatch on the anchor's Element parent — Comment anchors don't bubble.
      const errorObj = err instanceof Error ? err : new Error(String(err));
      queueMicrotask(() => {
        try {
          const target = anchor.parentNode as Element | null;
          if (target?.dispatchEvent) {
            target.dispatchEvent(
              new CustomEvent("sibu:error-propagate", { bubbles: true, detail: { error: errorObj } }),
            );
          }
        } catch {
          /* ignore dispatch failure */
        }
      });
    }
  });

  // Primary cleanup: registerDisposer on the anchor so `dispose()`,
  // `when()`, `match()`, and `each()` all clean up portal content.
  registerDisposer(anchor as unknown as HTMLElement, () => {
    disposed = true;
    if (portalContent) {
      dispose(portalContent);
      portalContent.remove();
      portalContent = null;
    }
  });

  return anchor;
}
