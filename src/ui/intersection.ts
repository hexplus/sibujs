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
  // Observation generation, bumped by every observe() and unobserve().
  // `disconnect()` removes targets but does not clear entries the observer has
  // already queued, so a notification task can still invoke a disconnected
  // observer's callback — without this check it would overwrite the state of
  // the element observed since.
  let generation = 0;

  function observe(element: HTMLElement): void {
    if (typeof IntersectionObserver === "undefined") return;
    unobserve();
    currentElement = element;
    const observation = ++generation;

    observer = new IntersectionObserver((entries) => {
      if (observation !== generation) return;
      const entry = entries[0];
      if (entry) {
        setIsIntersecting(entry.isIntersecting);
        setRatio(entry.intersectionRatio);
      }
    }, options);

    observer.observe(element);
  }

  function unobserve(): void {
    generation++;
    if (observer) {
      if (currentElement) observer.unobserve(currentElement);
      // Drop entries queued but not yet delivered; the generation check above
      // covers a notification task that is already scheduled.
      observer.takeRecords();
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
  // Terminal: set once the loader has run or cleanup has been called. A
  // disconnected observer can still deliver entries it had already queued, so
  // disconnecting alone neither prevents a second loader() call nor a call
  // after cleanup.
  let done = false;
  const stop = () => {
    done = true;
    observer.takeRecords();
    observer.disconnect();
  };
  const observer = new IntersectionObserver((entries) => {
    if (done) return;
    for (const entry of entries) {
      if (entry.isIntersecting) {
        stop();
        loader();
        break;
      }
    }
  }, options);

  observer.observe(element);

  return () => {
    if (!done) stop();
  };
}
