import { effect } from "@sibujs/core";
import { signal } from "@sibujs/core";
import { batch } from "@sibujs/core";

type ElementTarget = (() => HTMLElement | null) | { current: HTMLElement | null };
function resolveTarget(target: ElementTarget): () => HTMLElement | null {
  return typeof target === "function" ? target : () => target.current;
}

/**
 * resize tracks the dimensions of a target element reactively.
 * Uses the ResizeObserver API to monitor size changes.
 *
 * @param target Reactive getter or ref returning the HTMLElement to observe (or null)
 * @returns Object with reactive width/height getters and a dispose function
 */
export function resize(target: ElementTarget): {
  width: () => number;
  height: () => number;
  dispose: () => void;
} {
  const [width, setWidth] = signal(0);
  const [height, setHeight] = signal(0);
  let observer: ResizeObserver | null = null;

  if (typeof window === "undefined" || typeof ResizeObserver === "undefined") {
    return { width, height, dispose: () => {} };
  }

  const getter = resolveTarget(target);
  const cleanup = effect(() => {
    const el = getter();
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (!el) return;

    observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        batch(() => {
          setWidth(entry.contentRect.width);
          setHeight(entry.contentRect.height);
        });
      }
    });

    observer.observe(el);
  });

  function dispose() {
    cleanup();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  return { width, height, dispose };
}
