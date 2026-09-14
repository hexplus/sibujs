import { registerDisposer, unregisterDisposer } from "../core/rendering/dispose";
import { signal } from "../core/signals/signal";

/**
 * hover attaches reactive hover tracking to an element. Uses `pointerenter`
 * and `pointerleave` so it works on touch devices where a sustained press
 * triggers a hover state.
 *
 * @param target Element to track
 * @returns `{ hovered, dispose }` — reactive boolean plus cleanup
 *
 * @example
 * ```ts
 * const el = div({ class: "card" });
 * const h = hover(el);
 * effect(() => { el.classList.toggle("lifted", h.hovered()); });
 * ```
 */
export function hover(target: HTMLElement): {
  hovered: () => boolean;
  dispose: () => void;
} {
  const [hovered, setHovered] = signal(false);

  if (typeof window === "undefined") {
    return { hovered, dispose: () => {} };
  }

  const onEnter = () => setHovered(true);
  const onLeave = () => setHovered(false);

  target.addEventListener("pointerenter", onEnter);
  target.addEventListener("pointerleave", onLeave);

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    // A manual dispose must also drop the node-level registration below, or a
    // long-lived element accumulates one dead closure per attach/dispose cycle.
    // When dispose(node) is the caller, the entry is already gone and this is a
    // no-op.
    unregisterDisposer(target, dispose);
    target.removeEventListener("pointerenter", onEnter);
    target.removeEventListener("pointerleave", onLeave);
  }

  // Also release when the element is disposed, so the listeners don't leak if
  // the caller forgets to call dispose() (mirrors a11y.focus()/createListbox).
  registerDisposer(target, dispose);

  return { hovered, dispose };
}
