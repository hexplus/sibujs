import { reportError } from "../core/errors";
import { signal } from "../core/signals/signal";

/**
 * infiniteScroll combines IntersectionObserver with a data-fetching trigger
 * to implement infinite scroll behavior.
 *
 * ERROR CONTRACT: `onLoadMore` is user code and may reject. The observer
 * callback cannot `await` it, so the promise it starts is floating — and a
 * floating rejection is an unhandled rejection, which crashes a Node SSR
 * process and fires `window.onunhandledrejection` in a browser, for what is
 * really just a failed page of data. `loadMore()` therefore CONTAINS its own
 * failure: it reports through the framework's central error pipeline
 * (`reportError`, phase `"async"`) and never rejects to its caller. The
 * `loading` flag is always cleared, so a failed page does not wedge the list.
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
  // Bumped by dispose(). A load that settles after teardown compares its
  // captured generation and skips every state write and re-observe.
  let generation = 0;

  function createObserver(): void {
    if (typeof IntersectionObserver === "undefined") return;

    observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !loading() && hasMore() && !disposed) {
          // Explicitly discard the promise: `loadMore` is contained and never
          // rejects, so there is nothing left to handle here.
          void loadMore();
        }
      },
      { threshold },
    );

    if (sentinelRef.current) {
      observer.observe(sentinelRef.current);
    }
  }

  async function loadMore(): Promise<void> {
    const runGeneration = generation;
    setLoading(true);
    try {
      await onLoadMore();
    } catch (err) {
      // Contained, not swallowed: a rejecting user callback is surfaced through
      // the one place applications install reporting/telemetry, exactly like a
      // throwing effect or binding.
      reportError(err, { phase: "async", name: "infiniteScroll(onLoadMore)" });
    } finally {
      // Owner check before ANY state mutation. Without it a load in flight at
      // dispose() time would re-raise `loading` state on a torn-down controller
      // and re-arm the observer it had just disconnected.
      if (!disposed && runGeneration === generation) {
        setLoading(false);
        // If the sentinel is still intersecting after the append (e.g. the newly
        // loaded content didn't push it out of view, or the page isn't full yet),
        // the observer won't fire again on its own — re-observe to force a fresh
        // intersection check so loading doesn't stall.
        if (observer && _current && hasMore()) {
          observer.unobserve(_current);
          observer.observe(_current);
        }
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
    generation++;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    // Settle the flag here rather than leaving it to a pending completion that
    // is no longer allowed to write. Otherwise `loading()` stays permanently
    // true for anything still reading this controller's state.
    setLoading(false);
  }

  return { sentinelRef: originalRef, loading, dispose };
}
