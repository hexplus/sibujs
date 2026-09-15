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
  let inFlight = false;
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

  const revalidate = async (): Promise<void> => {
    if (disposed || inFlight) return;
    if (controller.signal.aborted) return;
    inFlight = true;
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
    } finally {
      inFlight = false;
    }
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
