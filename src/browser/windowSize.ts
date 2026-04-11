import { signal } from "../core/signals/signal";

/**
 * windowSize tracks the viewport dimensions as reactive signals.
 * Unlike `resize()` (which observes a specific element), this watches the
 * full window via the `resize` event.
 *
 * Useful for responsive layouts, breakpoint logic, and canvas sizing.
 *
 * @returns Reactive `width`, `height` getters and dispose
 *
 * @example
 * ```ts
 * const { width, height } = windowSize();
 * const isMobile = derived(() => width() < 768);
 * ```
 */
export function windowSize(): {
  width: () => number;
  height: () => number;
  dispose: () => void;
} {
  if (typeof window === "undefined") {
    const [width] = signal(0);
    const [height] = signal(0);
    return { width, height, dispose: () => {} };
  }

  const [width, setWidth] = signal(window.innerWidth);
  const [height, setHeight] = signal(window.innerHeight);

  const handler = () => {
    setWidth(window.innerWidth);
    setHeight(window.innerHeight);
  };

  window.addEventListener("resize", handler, { passive: true });

  function dispose() {
    window.removeEventListener("resize", handler);
  }

  return { width, height, dispose };
}
