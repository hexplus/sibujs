import { signal } from "../core/signals/signal";

export interface MouseOptions {
  /** Track touch events as well (unified pointer tracking). Default: true */
  touch?: boolean;
  /** Target element. Defaults to `window`. */
  target?: HTMLElement;
}

/**
 * mouse tracks the pointer position (mouse + optional touch) as reactive signals.
 * Returns `x`, `y` getters updated on every `pointermove` / `touchmove`.
 *
 * @param options Optional tracking configuration
 * @returns Reactive mouse coordinates with dispose function
 *
 * @example
 * ```ts
 * const { x, y, dispose } = mouse();
 * effect(() => console.log(`${x()}, ${y()}`));
 * ```
 */
export function mouse(options: MouseOptions = {}): {
  x: () => number;
  y: () => number;
  dispose: () => void;
} {
  const [x, setX] = signal(0);
  const [y, setY] = signal(0);

  if (typeof window === "undefined") {
    return { x, y, dispose: () => {} };
  }

  const target: HTMLElement | Window = options.target ?? window;
  const trackTouch = options.touch ?? true;

  const onMove = (e: MouseEvent) => {
    setX(e.clientX);
    setY(e.clientY);
  };

  const onTouchMove = (e: TouchEvent) => {
    if (e.touches.length === 0) return;
    setX(e.touches[0].clientX);
    setY(e.touches[0].clientY);
  };

  target.addEventListener("mousemove", onMove as EventListener, { passive: true });
  if (trackTouch) {
    target.addEventListener("touchmove", onTouchMove as EventListener, { passive: true });
  }

  function dispose() {
    target.removeEventListener("mousemove", onMove as EventListener);
    if (trackTouch) {
      target.removeEventListener("touchmove", onTouchMove as EventListener);
    }
  }

  return { x, y, dispose };
}
