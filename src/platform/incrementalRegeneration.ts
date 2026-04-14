import { signal } from "../core/signals/signal";

export interface ISROptions<T> {
  revalidateAfter: number; // ms
  fetcher: (ctx?: { signal: AbortSignal }) => Promise<T>;
  initialData?: T;
}

/**
 * Creates an Incremental Static Regeneration (ISR) resource.
 * Data is fetched initially, then automatically revalidated after the
 * specified interval using setInterval.
 */
export function createISR<T>(options: ISROptions<T>): {
  data: () => T | undefined;
  isStale: () => boolean;
  revalidate: () => Promise<void>;
  dispose: () => void;
} {
  const { revalidateAfter, fetcher, initialData } = options;

  const [data, setData] = signal<T | undefined>(initialData);
  const [timestamp, setTimestamp] = signal<number>(initialData !== undefined ? Date.now() : 0);

  const controller = new AbortController();
  let inFlight = false;
  let disposed = false;

  const isStale = (): boolean => {
    const ts = timestamp();
    if (ts === 0) return true;
    return Date.now() - ts >= revalidateAfter;
  };

  const revalidate = async (): Promise<void> => {
    if (disposed || inFlight) return;
    if (controller.signal.aborted) return;
    inFlight = true;
    try {
      const result = await fetcher({ signal: controller.signal });
      if (disposed || controller.signal.aborted) return;
      setData(result);
      setTimestamp(Date.now());
    } finally {
      inFlight = false;
    }
  };

  // Initial fetch and interval revalidates: fire-and-forget, so attach .catch
  // to surface fetcher rejections without becoming unhandled rejections.
  if (initialData === undefined) {
    revalidate().catch((err) => {
      if (typeof console !== "undefined") console.warn("[SibuJS ISR] initial fetch failed", err);
    });
  }

  const intervalId = setInterval(() => {
    revalidate().catch((err) => {
      if (typeof console !== "undefined") console.warn("[SibuJS ISR] revalidate failed", err);
    });
  }, revalidateAfter);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(intervalId);
    controller.abort();
  };

  return { data, isStale, revalidate, dispose };
}
