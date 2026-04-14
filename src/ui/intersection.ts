import { signal } from "../core/signals/signal";

// ============================================================================
// INTERSECTION OBSERVER HOOK
// ============================================================================

export interface IntersectionResult {
  isIntersecting: () => boolean;
  intersectionRatio: () => number;
  observe: (element: HTMLElement) => void;
  unobserve: () => void;
}

/**
 * intersection provides reactive intersection observer state.
 */
export function intersection(options?: IntersectionObserverInit): IntersectionResult {
  const [isIntersecting, setIsIntersecting] = signal(false);
  const [ratio, setRatio] = signal(0);
  let observer: IntersectionObserver | null = null;
  let currentElement: HTMLElement | null = null;

  function observe(element: HTMLElement): void {
    if (typeof IntersectionObserver === "undefined") return;
    unobserve();
    currentElement = element;

    observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setIsIntersecting(entry.isIntersecting);
        setRatio(entry.intersectionRatio);
      }
    }, options);

    observer.observe(element);
  }

  function unobserve(): void {
    if (observer) {
      if (currentElement) observer.unobserve(currentElement);
      observer.disconnect();
      observer = null;
      currentElement = null;
    }
  }

  return {
    isIntersecting,
    intersectionRatio: ratio,
    observe,
    unobserve,
  };
}

/**
 * Lazy-load utility using IntersectionObserver.
 * Calls the loader function when element becomes visible.
 */
export function lazyLoad(element: HTMLElement, loader: () => void, options?: IntersectionObserverInit): () => void {
  if (typeof IntersectionObserver === "undefined") {
    loader();
    return () => {};
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        loader();
        observer.disconnect();
        break;
      }
    }
  }, options);

  observer.observe(element);

  return () => observer.disconnect();
}
