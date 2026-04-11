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

  function dispose() {
    target.removeEventListener("pointerenter", onEnter);
    target.removeEventListener("pointerleave", onLeave);
  }

  return { hovered, dispose };
}
