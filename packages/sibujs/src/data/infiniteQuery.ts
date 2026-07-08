import { derived } from "@sibujs/core";
import { effect } from "@sibujs/core";
import { signal } from "@sibujs/core";
import { batch } from "@sibujs/core";
import type { RetryOptions } from "./retry";
import { withRetry } from "./retry";

export interface InfiniteQueryOptions<TData, TPageParam = number> {
  /** Get the param for the next page. Return undefined to signal end. */
  getNextPageParam: (lastPage: TData, allPages: TData[]) => TPageParam | undefined;
  /** Get the param for the previous page. Optional. */
  getPreviousPageParam?: (firstPage: TData, allPages: TData[]) => TPageParam | undefined;
  /** Initial page param. Default: 0 (for number) */
  initialPageParam?: TPageParam;
  /**
   * Maximum number of pages to retain. When exceeded, the oldest page is
   * dropped from the opposite end (sliding window) to bound memory. Unset =
   * unbounded.
   */
  maxPages?: number;
  /** Whether to fetch on creation. Default: true */
  enabled?: boolean;
  /** Retry options */
  retry?: RetryOptions;
  /** Called on successful page fetch */
  onSuccess?: (data: TData[]) => void;
  /** Called on fetch error */
  onError?: (error: Error) => void;
}

export interface InfiniteQueryResult<TData> {
  /** All fetched pages combined */
  data: () => TData[] | undefined;
  /** Individual pages array */
  pages: () => TData[];
  /** True when loading the first page */
  loading: () => boolean;
  /** True when any fetch is in progress */
  fetching: () => boolean;
  /** True when fetching the next page */
  fetchingNextPage: () => boolean;
  /** True when fetching the previous page */
  fetchingPreviousPage: () => boolean;
  /** Error from the last fetch */
  error: () => Error | undefined;
  /** Whether there are more pages to fetch */
  hasNextPage: () => boolean;
  /** Whether there are previous pages */
  hasPreviousPage: () => boolean;
  /** Fetch the next page */
  fetchNextPage: () => Promise<void>;
  /** Fetch the previous page */
  fetchPreviousPage: () => Promise<void>;
  /** Refetch all pages */
  refetch: () => Promise<void>;
  /** Cleanup */
  dispose: () => void;
}

export function infiniteQuery<TData, TPageParam = number>(
  key: string | (() => string),
  fetcher: (ctx: { signal: AbortSignal; pageParam: TPageParam }) => Promise<TData>,
  options: InfiniteQueryOptions<TData, TPageParam>,
): InfiniteQueryResult<TData> {
  const {
    getNextPageParam,
    getPreviousPageParam,
    initialPageParam = 0 as TPageParam,
    maxPages,
    enabled = true,
    retry: retryOptions,
    onSuccess,
    onError,
  } = options;

  const resolveKey = typeof key === "function" ? key : () => key;

  const [pages, setPages] = signal<TData[]>([]);
  const [isFetching, setIsFetching] = signal(false);
  const [isFetchingNext, setIsFetchingNext] = signal(false);
  const [isFetchingPrev, setIsFetchingPrev] = signal(false);
  const [error, setError] = signal<Error | undefined>(undefined);
  const [nextPageParam, setNextPageParam] = signal<TPageParam | undefined>(initialPageParam);
  const [prevPageParam, setPrevPageParam] = signal<TPageParam | undefined>(undefined);

  const data = derived(() => {
    const p = pages();
    return p.length > 0 ? p : undefined;
  });
  const loading = derived(() => isFetching() && pages().length === 0);
  const hasNextPage = derived(() => nextPageParam() !== undefined);
  const hasPreviousPage = derived(() => prevPageParam() !== undefined);

  let abortController: AbortController | null = null;
  let disposed = false;
  let runId = 0;
  // Tracks the in-flight fetch so the public fetchNextPage/fetchPreviousPage
  // can dedup instead of aborting a running fetch and silently dropping a page.
  let inFlight: Promise<void> | null = null;

  function fetchPage(pageParam: TPageParam, direction: "next" | "prev" | "initial"): Promise<void> {
    if (disposed) return Promise.resolve();

    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;
    const myRun = ++runId;

    batch(() => {
      setIsFetching(true);
      if (direction === "next") setIsFetchingNext(true);
      if (direction === "prev") setIsFetchingPrev(true);
      setError(undefined);
    });

    const promise = (async () => {
      try {
        const page = await withRetry(() => fetcher({ signal, pageParam }), retryOptions, undefined, signal);

        if (disposed || myRun !== runId) return;

        const currentPages = pages();
        let newPages: TData[] = direction === "prev" ? [page, ...currentPages] : [...currentPages, page];

        // Sliding-window cap: drop from the end opposite to the growth side so
        // the page array (and its memory) stays bounded.
        if (maxPages != null && maxPages > 0 && newPages.length > maxPages) {
          newPages = direction === "prev" ? newPages.slice(0, maxPages) : newPages.slice(newPages.length - maxPages);
        }

        // Recompute params from the *window edges*, not the page just fetched —
        // after a previous-page fetch (or a trim) the last page is what governs
        // hasNextPage, and the first page governs hasPreviousPage.
        const nextParam = getNextPageParam(newPages[newPages.length - 1], newPages);
        const prevParam = getPreviousPageParam?.(newPages[0], newPages);

        batch(() => {
          setPages(newPages);
          setNextPageParam(nextParam);
          setPrevPageParam(prevParam);
          setIsFetching(false);
          setIsFetchingNext(false);
          setIsFetchingPrev(false);
        });

        onSuccess?.(newPages);
      } catch (err) {
        if (disposed || myRun !== runId) return;
        if (err instanceof DOMException && err.name === "AbortError") return;

        const errorObj = err instanceof Error ? err : new Error(String(err));
        batch(() => {
          setError(errorObj);
          setIsFetching(false);
          setIsFetchingNext(false);
          setIsFetchingPrev(false);
        });
        onError?.(errorObj);
      }
    })();

    inFlight = promise;
    void promise.finally(() => {
      if (inFlight === promise) inFlight = null;
    });
    return promise;
  }

  const effectCleanup = effect(() => {
    resolveKey();
    if (enabled) {
      abortController?.abort();
      batch(() => {
        setPages([]);
        setNextPageParam(initialPageParam);
        setPrevPageParam(undefined);
      });
      fetchPage(initialPageParam, "initial");
    }
  });

  function fetchNextPage(): Promise<void> {
    // Already fetching (initial load or another page) — return that in-flight
    // promise instead of aborting it and dropping the page mid-flight.
    if (inFlight) return inFlight;
    const param = nextPageParam();
    if (param === undefined) return Promise.resolve();
    return fetchPage(param, "next");
  }

  function fetchPreviousPage(): Promise<void> {
    if (inFlight) return inFlight;
    const param = prevPageParam();
    if (param === undefined) return Promise.resolve();
    return fetchPage(param, "prev");
  }

  async function refetch(): Promise<void> {
    batch(() => {
      setPages([]);
      setNextPageParam(initialPageParam);
      setPrevPageParam(undefined);
    });
    await fetchPage(initialPageParam, "initial");
  }

  function dispose(): void {
    disposed = true;
    abortController?.abort();
    effectCleanup();
  }

  return {
    data,
    pages,
    loading,
    fetching: isFetching,
    fetchingNextPage: isFetchingNext,
    fetchingPreviousPage: isFetchingPrev,
    error,
    hasNextPage,
    hasPreviousPage,
    fetchNextPage,
    fetchPreviousPage,
    refetch,
    dispose,
  };
}
