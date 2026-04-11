import { signal } from "../core/signals/signal";

export type SwipeDirection = "left" | "right" | "up" | "down";

export interface SwipeOptions {
  /** Minimum distance in pixels for a swipe to count. Default: 50 */
  threshold?: number;
  /** Fired when a swipe is detected. */
  onSwipe?: (direction: SwipeDirection, distance: number) => void;
}

/**
 * swipe detects touch swipe gestures on a target element.
 * Returns a reactive signal of the last-detected direction plus dispose.
 *
 * Works on touch devices (touchstart/touchend). Uses only native events —
 * no external library.
 *
 * @param target Element to attach listeners to
 * @param options Threshold and onSwipe callback
 * @returns Reactive direction getter and dispose
 *
 * @example
 * ```ts
 * const el = div({ class: "card" });
 * swipe(el, {
 *   threshold: 80,
 *   onSwipe: (dir) => {
 *     if (dir === "left") goNext();
 *     if (dir === "right") goPrev();
 *   },
 * });
 * ```
 */
export function swipe(
  target: HTMLElement,
  options: SwipeOptions = {},
): { direction: () => SwipeDirection | null; dispose: () => void } {
  const threshold = options.threshold ?? 50;
  const [direction, setDirection] = signal<SwipeDirection | null>(null);

  if (typeof window === "undefined") {
    return { direction, dispose: () => {} };
  }

  let startX = 0;
  let startY = 0;
  let tracking = false;

  const onStart = (e: TouchEvent) => {
    if (e.touches.length === 0) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  };

  const onEnd = (e: TouchEvent) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (Math.max(absX, absY) < threshold) return;

    let dir: SwipeDirection;
    if (absX > absY) {
      dir = dx > 0 ? "right" : "left";
    } else {
      dir = dy > 0 ? "down" : "up";
    }
    setDirection(dir);
    options.onSwipe?.(dir, Math.max(absX, absY));
  };

  target.addEventListener("touchstart", onStart, { passive: true });
  target.addEventListener("touchend", onEnd, { passive: true });

  function dispose() {
    target.removeEventListener("touchstart", onStart);
    target.removeEventListener("touchend", onEnd);
  }

  return { direction, dispose };
}
