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
  // The initiating touch. A gesture is ONE touch: its end is matched by
  // identifier, a cancel ends it, and a second finger abandons it. Comparing
  // against `changedTouches[0]` used to pair unrelated fingers, and ignoring
  // `touchcancel` let a browser-cancelled gesture complete later.
  let trackedId: number | null = null;

  const idOf = (t: Touch): number => t.identifier ?? 0;
  const findTracked = (list: TouchList | undefined): Touch | null => {
    if (!list) return null;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (idOf(t) === trackedId) return t;
    }
    return null;
  };

  const onStart = (e: TouchEvent) => {
    if (trackedId !== null || e.touches.length !== 1) {
      // Became (or started as) multi-touch: not a swipe.
      trackedId = null;
      return;
    }
    const touch = e.changedTouches?.[0] ?? e.touches[0];
    if (!touch) return;
    trackedId = idOf(touch);
    startX = touch.clientX;
    startY = touch.clientY;
  };

  const onCancel = (e: TouchEvent) => {
    if (trackedId !== null && findTracked(e.changedTouches)) trackedId = null;
  };

  const onEnd = (e: TouchEvent) => {
    if (trackedId === null) return;
    const touch = findTracked(e.changedTouches);
    // Another finger lifted; the tracked touch is still down.
    if (!touch) return;
    trackedId = null;
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
  target.addEventListener("touchcancel", onCancel, { passive: true });

  function dispose() {
    target.removeEventListener("touchstart", onStart);
    target.removeEventListener("touchend", onEnd);
    target.removeEventListener("touchcancel", onCancel);
    trackedId = null;
  }

  return { direction, dispose };
}
