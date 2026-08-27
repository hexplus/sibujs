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

  /**
   * Evaluate the caller's `hasMore()` inside the same containment as
   * `onLoadMore()`.
   *
   * It is user code in two hostile positions: inside a native
   * `IntersectionObserver` callback, where a throw escapes anywhere the
   * application could catch it, and inside `loadMore()`'s `finally`, where a
   * throw propagates out of a function documented never to reject — and whose
   * callers invoke it as `void loadMore()`, so the rejection has no handler at
   * all.
   *
   * A predicate that cannot answer is treated as `false`: of the two possible
   * guesses that is the one that stops, rather than the one that keeps asking a
   * broken predicate for more pages.
   */
  function safeHasMore(): boolean {
    try {
      return hasMore();
    } catch (err) {
      reportError(err, { phase: "async", name: "infiniteScroll(hasMore)" });
      return false;
    }
  }

  function createObserver(): void {
    if (typeof IntersectionObserver === "undefined") return;

    // Declared before construction so the callback can close over THIS
    // observer's identity rather than over whatever `observer` happens to hold
    // when it eventually runs.
    let createdObserver!: IntersectionObserver;

    createdObserver = new IntersectionObserver(
      (entries) => {
        // OWNERSHIP FIRST — before entries, signals, or any caller code.
        //
        // `disconnect()` stops future notifications; it does not un-queue a
        // callback the engine has already scheduled. So this can run after
        // `dispose()`, or after a sentinel swap replaced this observer, and in
        // both cases it belongs to an attachment that no longer exists.
        //
        // The order matters: `safeHasMore()` used to be evaluated before the
        // `disposed` check, which meant a torn-down controller still executed
        // caller-controlled code and could report predicate errors from work
        // nobody was waiting on. And with no identity check at all, a callback
        // queued against sentinel A could start a load that went on to publish
        // state for — and re-observe — sentinel B.
        if (disposed || observer !== createdObserver) return;

        const entry = entries[0];
        if (entry?.isIntersecting && !loading() && safeHasMore()) {
          // Explicitly discard the promise: `loadMore` is contained and never
          // rejects, so there is nothing left to handle here.
          void loadMore();
        }
      },
      { threshold },
    );

    observer = createdObserver;

    if (sentinelRef.current) {
      createdObserver.observe(sentinelRef.current);
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
        if (observer && _current && safeHasMore()) {
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
      // A DIFFERENT element is a new attachment, and therefore a new ownership
      // generation: a load started for the previous sentinel loses the right to
      // publish state or to touch the new sentinel's observer. Re-assigning the
      // SAME element is not a new attachment, so its in-flight load keeps its
      // rights and no generation is burned.
      const attachmentChanged = el !== _current;
      _current = el;

      if (attachmentChanged) {
        generation++;
        // Release the superseded load's claim on `loading`.
        //
        // The generation bump above already stops that load from clearing the
        // flag itself, so without this it would stay `true` forever — and the
        // observer gate (`!loading()`) would then block the NEW sentinel from
        // ever starting a load of its own. Settling here is what lets the new
        // attachment work while keeping the stale one unable to write.
        setLoading(false);
      }

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
