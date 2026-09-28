import { signal } from "../core/signals/signal";
import { batch } from "../reactivity/batch";

export interface ISROptions<T> {
  revalidateAfter: number; // ms
  fetcher: (ctx?: { signal: AbortSignal }) => Promise<T>;
  initialData?: T;
}

/**
 * Creates an Incremental Static Regeneration (ISR) resource.
 * Data is fetched initially, then automatically revalidated once it goes stale.
 *
 * `isStale()` is a reactive signal: it flips to `true` when `revalidateAfter`
 * elapses since the last successful fetch (effects re-run at that moment), stays
 * `true` while a revalidation is pending or after one fails, and returns to
 * `false` when a revalidation succeeds.
 *
 * `revalidate()` called while a revalidation is running joins it instead of
 * starting another: the fetcher runs once, and every caller's promise settles
 * — resolving, or rejecting with the same error — when that fetch does.
 *
 * @throws RangeError when `revalidateAfter` is not a positive finite number.
 */
export function createISR<T>(options: ISROptions<T>): {
  data: () => T | undefined;
  isStale: () => boolean;
  revalidate: () => Promise<void>;
  dispose: () => void;
} {
  const { revalidateAfter, fetcher, initialData } = options;
  if (!Number.isFinite(revalidateAfter) || revalidateAfter <= 0) {
    throw new RangeError(`[SibuJS ISR] revalidateAfter must be a positive finite number, got ${revalidateAfter}`);
  }

  const [data, setData] = signal<T | undefined>(initialData);
  // Staleness is stored, not derived from Date.now() on read: a read that
  // depends on the clock has no reactive source, so nothing re-ran when the
  // deadline passed. A timer flips this signal at the deadline instead.
  const [stale, setStale] = signal<boolean>(initialData === undefined);

  const controller = new AbortController();
  // The active logical revalidation. A boolean used to deduplicate the fetch
  // but handed a concurrent caller an already-resolved promise, so
  // `await revalidate()` returned before the running fetch had finished.
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const clearDeadline = (): void => {
    if (deadline !== undefined) {
      clearTimeout(deadline);
      deadline = undefined;
    }
  };

  // After a successful fetch (or with initial data): data is fresh until
  // `revalidateAfter` elapses, then it is marked stale and revalidated.
  const armDeadline = (): void => {
    clearDeadline();
    deadline = setTimeout(() => {
      deadline = undefined;
      if (disposed) return;
      setStale(true);
      revalidate().catch((err) => {
        if (typeof console !== "undefined") console.warn("[SibuJS ISR] revalidate failed", err);
      });
    }, revalidateAfter);
  };

  // One fetch and its outcome. Exactly one deadline is armed per settled fetch
  // (none once disposed), whichever path started it and however many callers
  // joined it.
  const run = async (): Promise<void> => {
    try {
      const result = await fetcher({ signal: controller.signal });
      if (disposed || controller.signal.aborted) return;
      batch(() => {
        setData(result);
        setStale(false);
      });
      armDeadline();
    } catch (err) {
      // A failed fetch keeps the data stale and retries after the same period;
      // arming only on success stopped automatic revalidation for good after a
      // single transient error.
      if (!disposed && !controller.signal.aborted) armDeadline();
      throw err;
    }
  };

  /**
   * Start a revalidation, or join the one already running: a concurrent call
   * returns the SAME promise, so every caller settles when that fetch settles
   * and sees the same rejection. The fetcher runs once. After it settles, the
   * next call starts a new fetch.
   */
  const revalidate = (): Promise<void> => {
    if (disposed || controller.signal.aborted) return Promise.resolve();
    if (inFlight) return inFlight;
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const current = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Published before the fetcher is called, so a revalidate() issued from
    // inside the fetcher joins this request instead of starting another.
    inFlight = current;
    // Cleared before the callers resume, so a caller that revalidates again as
    // soon as it wakes starts a fresh fetch. The identity check keeps a settle
    // from clearing any request but its own.
    const release = () => {
      if (inFlight === current) inFlight = null;
    };
    run().then(
      () => {
        release();
        resolve();
      },
      (err) => {
        release();
        reject(err);
      },
    );
    return current;
  };

  // Initial fetch: fire-and-forget, so attach .catch to surface fetcher
  // rejections without becoming unhandled rejections. A failed revalidation
  // leaves the data stale and is retried after `revalidateAfter`.
  if (initialData === undefined) {
    revalidate().catch((err) => {
      if (typeof console !== "undefined") console.warn("[SibuJS ISR] initial fetch failed", err);
    });
  } else {
    armDeadline();
  }

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearDeadline();
    controller.abort();
  };

  return { data, isStale: stale, revalidate, dispose };
}
