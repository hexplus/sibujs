import { derived } from "../core/signals/derived";
import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";
import { batch } from "../reactivity/batch";
import type { RetryOptions } from "./retry";
import { withRetry } from "./retry";

export interface InfiniteQueryOptions<TData, TPageParam = number> {
  /** Get the param for the next page. Return undefined to signal end. */
  getNextPageParam: (lastPage: TData, allPages: TData[]) => TPageParam | undefined;
  /** Get the param for the previous page. Optional. */
  getPreviousPageParam?: (firstPage: TData, allPages: TData[]) => TPageParam | undefined;
  /** Initial page param. Default: 0 (for number) */
  initialPageParam?: TPageParam;
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

  async function fetchPage(pageParam: TPageParam, direction: "next" | "prev" | "initial"): Promise<void> {
    if (disposed) return;

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

    try {
      const page = await withRetry(() => fetcher({ signal, pageParam }), retryOptions, undefined, signal);

      if (disposed || myRun !== runId) return;

      const currentPages = pages();
      let newPages: TData[];

      if (direction === "prev") {
        newPages = [page, ...currentPages];
      } else {
        newPages = [...currentPages, page];
      }

      const nextParam = getNextPageParam(page, newPages);
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
    const param = nextPageParam();
    if (param === undefined) return Promise.resolve();
    return fetchPage(param, "next");
  }

  function fetchPreviousPage(): Promise<void> {
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
