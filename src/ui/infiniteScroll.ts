import { signal } from "../core/signals/signal";

/**
 * infiniteScroll combines IntersectionObserver with a data-fetching trigger
 * to implement infinite scroll behavior.
 */
export function infiniteScroll(options: {
  onLoadMore: () => Promise<void>;
  hasMore: () => boolean;
  threshold?: number;
}): {
  sentinelRef: { current: HTMLElement | null };
  loading: () => boolean;
  dispose: () => void;
} {
  const { onLoadMore, hasMore, threshold = 0 } = options;
  const [loading, setLoading] = signal(false);
  const sentinelRef: { current: HTMLElement | null } = { current: null };
  let observer: IntersectionObserver | null = null;
  let disposed = false;

  function createObserver(): void {
    if (typeof IntersectionObserver === "undefined") return;

    observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !loading() && hasMore() && !disposed) {
          loadMore();
        }
      },
      { threshold },
    );

    if (sentinelRef.current) {
      observer.observe(sentinelRef.current);
    }
  }

  async function loadMore(): Promise<void> {
    setLoading(true);
    try {
      await onLoadMore();
    } finally {
      setLoading(false);
      // If the sentinel is still intersecting after the append (e.g. the newly
      // loaded content didn't push it out of view, or the page isn't full yet),
      // the observer won't fire again on its own — re-observe to force a fresh
      // intersection check so loading doesn't stall.
      if (!disposed && observer && _current && hasMore()) {
        observer.unobserve(_current);
        observer.observe(_current);
      }
    }
  }

  // Use a getter/setter proxy on sentinelRef to auto-observe when element is set
  const originalRef = sentinelRef;
  let _current: HTMLElement | null = null;
  Object.defineProperty(originalRef, "current", {
    get() {
      return _current;
    },
    set(el: HTMLElement | null) {
      _current = el;
      // Disconnect old observer
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      // Create new observer if element is set
      if (el && !disposed) {
        createObserver();
      }
    },
    configurable: true,
  });

  function dispose(): void {
    disposed = true;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  return { sentinelRef: originalRef, loading, dispose };
}
