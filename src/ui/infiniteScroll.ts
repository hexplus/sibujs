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

  /**
   * The complete identity of one sentinel attachment.
   *
   * Ownership is three-dimensional and all three are load-bearing:
   *
   *   generation  the attachment epoch, advanced by dispose() and by a sentinel
   *               change — catches work whose attachment has been superseded
   *   observer    the exact IntersectionObserver instance — catches a callback
   *               queued against an observer that has since been replaced
   *   sentinel    the exact element — the thing native calls must be aimed at
   *
   * Carrying them together, rather than comparing scattered variables at each
   * site, is what makes it possible to re-check ownership cheaply after every
   * reentrant boundary — and what stops native calls from being aimed at
   * whatever `observer` / `_current` happen to hold by then.
   */
  interface AttachmentOwner {
    generation: number;
    observer: IntersectionObserver;
    sentinel: HTMLElement;
  }

  /**
   * Does `owner` still own this controller's current attachment?
   *
   * Called again after EVERY reentrant boundary. Passing an ownership check
   * before invoking application code does not grant permanent ownership:
   * `hasMore()` may synchronously call `dispose()` or reassign
   * `sentinelRef.current` and then return `true`, and signal setters drain
   * subscribers synchronously in this framework — so an effect reading
   * `loading()` runs inline and can revoke ownership just as easily.
   */
  function ownsAttachment(owner: AttachmentOwner): boolean {
    return !disposed && generation === owner.generation && observer === owner.observer && _current === owner.sentinel;
  }

  function createObserver(): void {
    if (typeof IntersectionObserver === "undefined") return;

    // Declared before construction so the callback can close over THIS
    // observer's identity rather than over whatever `observer` happens to hold
    // when it eventually runs.
    let createdObserver!: IntersectionObserver;

    createdObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;

        // Snapshot the FULL attachment identity before any caller code runs, so
        // the load that follows is authorized by — and bound to — this exact
        // attachment rather than to whatever state exists after the predicate
        // has had its say.
        const sentinel = _current;
        if (!sentinel) return;
        const owner: AttachmentOwner = { generation, observer: createdObserver, sentinel };

        // `disconnect()` stops future notifications; it does not un-queue a
        // callback the engine already scheduled. So this can run after
        // dispose(), or after a sentinel swap replaced this observer.
        if (!ownsAttachment(owner) || loading()) return;

        const shouldLoad = safeHasMore();

        // REVALIDATE. `safeHasMore()` is arbitrary application code: it may have
        // disposed the controller or swapped the sentinel and still returned
        // `true`. Without this, a disposed controller started a load that then
        // could not clear its own `loading` flag, and a superseded observer
        // started work that went on to publish state for the newer attachment.
        if (!shouldLoad || !ownsAttachment(owner)) return;

        // Explicitly discard the promise: `loadMore` is contained and never
        // rejects, so there is nothing left to handle here.
        void loadMore(owner);
      },
      { threshold },
    );

    observer = createdObserver;

    if (sentinelRef.current) {
      createdObserver.observe(sentinelRef.current);
    }
  }

  /**
   * Run one page load on behalf of `owner`.
   *
   * Never rejects — the observer starts it as `void loadMore(owner)`, so any
   * escape here becomes an unhandled rejection. That includes the native
   * observer calls at the end: a previous version reached them through the
   * mutable `observer` variable after `safeHasMore()` had nulled it via
   * `dispose()`, and the resulting TypeError escaped from a `finally` block.
   */
  async function loadMore(owner: AttachmentOwner): Promise<void> {
    try {
      setLoading(true);
      // Signal setters drain subscribers synchronously here, so an effect
      // reading `loading()` has just run and may have disposed the controller
      // or swapped the sentinel. The revoking action settles `loading` itself
      // (dispose() clears it; a sentinel change clears it), so returning here
      // cannot strand the flag.
      if (!ownsAttachment(owner)) return;

      try {
        await onLoadMore();
      } catch (err) {
        // Contained, not swallowed: a rejecting user callback is surfaced
        // through the one place applications install reporting/telemetry,
        // exactly like a throwing effect or binding.
        reportError(err, { phase: "async", name: "infiniteScroll(onLoadMore)" });
      }

      // The await is the widest reentrant gap of all.
      if (!ownsAttachment(owner)) return;
      setLoading(false);

      // …and publishing that clears subscribers synchronously too.
      if (!ownsAttachment(owner)) return;

      // If the sentinel is still intersecting after the append (e.g. the newly
      // loaded content didn't push it out of view, or the page isn't full yet),
      // the observer won't fire again on its own — re-observe to force a fresh
      // intersection check so loading doesn't stall.
      const shouldContinue = safeHasMore();
      if (!shouldContinue || !ownsAttachment(owner)) return;

      // Aimed at the CAPTURED observer and sentinel. Reading the mutable
      // `observer` / `_current` here would re-introduce the whole bug class:
      // between the final check and the call there is no further boundary, but
      // the shared variables may already describe a different attachment.
      owner.observer.unobserve(owner.sentinel);
      owner.observer.observe(owner.sentinel);
    } catch (err) {
      // Absolute backstop for the never-rejects invariant, including a throw
      // from a native observer method or from a synchronous subscriber.
      reportError(err, { phase: "async", name: "infiniteScroll(loadMore)" });
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
      // Re-assigning the SAME element is not a new attachment, so it is a
      // complete no-op — including leaving the observer instance alone.
      // Rebuilding it would silently revoke an in-flight load's ownership,
      // since observer identity is part of that ownership: the load would
      // survive the generation check and then fail the observer check, ending
      // with `loading` stranded true and no one able to clear it.
      if (el === _current) return;

      // A DIFFERENT element is a new attachment, and therefore a new ownership
      // generation: a load started for the previous sentinel loses the right to
      // publish state or to touch the new sentinel's observer.
      _current = el;
      generation++;

      // Release the superseded load's claim on `loading`.
      //
      // The generation bump above already stops that load from clearing the
      // flag itself, so without this it would stay `true` forever — and the
      // observer gate (`!loading()`) would then block the NEW sentinel from
      // ever starting a load of its own. Settling here is what lets the new
      // attachment work while keeping the stale one unable to write.
      setLoading(false);

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
