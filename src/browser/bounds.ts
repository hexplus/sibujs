import { signal } from "../core/signals/signal";

export interface BoundsRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

const ZERO: BoundsRect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};

function readRect(el: Element): BoundsRect {
  const r = el.getBoundingClientRect();
  return {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    top: r.top,
    left: r.left,
    right: r.right,
    bottom: r.bottom,
  };
}

/**
 * bounds tracks an element's `getBoundingClientRect()` as a reactive signal.
 * Updates when the element resizes OR when the window scrolls (so absolute
 * top/left stay accurate for overlays, tooltips, and popovers).
 *
 * Implementation detail: uses a `ResizeObserver` for size changes and a
 * passive window `scroll` listener for position changes. Both are torn down
 * on `dispose()`.
 *
 * @example
 * ```ts
 * const el = div({ class: "anchor" });
 * const rect = bounds(el);
 * effect(() => {
 *   const r = rect.rect();
 *   positionTooltip(r.left, r.bottom);
 * });
 * ```
 */
export function bounds(target: Element): {
  rect: () => BoundsRect;
  refresh: () => void;
  dispose: () => void;
} {
  const [rect, setRect] = signal<BoundsRect>(ZERO);

  if (typeof window === "undefined" || !target) {
    return {
      rect,
      refresh: () => {},
      dispose: () => {},
    };
  }

  function refresh() {
    setRect(readRect(target));
  }

  refresh();

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(refresh);
    resizeObserver.observe(target);
  }

  const onScroll = () => refresh();
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });

  function dispose() {
    resizeObserver?.disconnect();
    window.removeEventListener("scroll", onScroll, { capture: true });
  }

  return { rect, refresh, dispose };
}
