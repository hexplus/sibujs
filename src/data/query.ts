import { derived } from "../core/signals/derived";
import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";
import { batch } from "../reactivity/batch";
import type { RetryOptions } from "./retry";
import { withRetry } from "./retry";

export interface QueryOptions<T> {
  /** Time in ms before cached data is considered stale. Default: 0 (always stale) */
  staleTime?: number;
  /** Time in ms to keep unused cache entries. Default: 300000 (5 min) */
  cacheTime?: number;
  /** Whether to fetch on creation. Default: true */
  enabled?: boolean;
  /** Retry options for failed fetches */
  retry?: RetryOptions;
  /** Initial data before first fetch */
  initialData?: T;
  /** Auto-refetch interval in ms */
  refetchInterval?: number;
  /** Refetch when window regains focus */
  refetchOnWindowFocus?: boolean;
  /** Refetch when network reconnects */
  refetchOnReconnect?: boolean;
  /** Called on successful fetch */
  onSuccess?: (data: T) => void;
  /** Called on fetch error */
  onError?: (error: Error) => void;
  /** Called on fetch settle (success or error) */
  onSettled?: () => void;
  /** Transform fetched data before returning to consumers. Cache stores raw data. */
  select?: (data: T) => T;
}

export interface QueryResult<T> {
  /** Reactive getter for the cached data */
  data: () => T | undefined;
  /** Reactive getter: true when fetching with no cached data */
  loading: () => boolean;
  /** Reactive getter: true when any fetch is in progress */
  fetching: () => boolean;
  /** Reactive getter for the error state */
  error: () => Error | undefined;
  /** Reactive getter: whether cached data is stale */
  isStale: () => boolean;
  /** Manually trigger a refetch */
  refetch: () => Promise<void>;
  /** Cleanup subscriptions and timers */
  dispose: () => void;
}

interface CacheEntry {
  data: unknown;
  error: Error | undefined;
  dataUpdatedAt: number;
  subscribers: number;
  gcTimer: ReturnType<typeof setTimeout> | null;
  promise: Promise<unknown> | null;
  listeners: Set<() => void>;
  refetchers: Set<() => Promise<void>>;
}

const queryCache = new Map<string, CacheEntry>();

function getOrCreateEntry(key: string, initialData?: unknown): CacheEntry {
  let entry = queryCache.get(key);
  if (!entry) {
    entry = {
      data: initialData,
      error: undefined,
      dataUpdatedAt: initialData !== undefined ? Date.now() : 0,
      subscribers: 0,
      gcTimer: null,
      promise: null,
      listeners: new Set(),
      refetchers: new Set(),
    };
    queryCache.set(key, entry);
  }
  return entry;
}

export function query<T>(
  key: string | (() => string),
  fetcher: (ctx: { signal: AbortSignal; key: string }) => Promise<T>,
  options: QueryOptions<T> = {},
): QueryResult<T> {
  const {
    staleTime = 0,
    cacheTime = 300_000,
    enabled = true,
    retry: retryOptions,
    initialData,
    refetchInterval,
    refetchOnWindowFocus = false,
    refetchOnReconnect = false,
    onSuccess,
    onError,
    onSettled,
    select,
  } = options;

  const resolveKey = typeof key === "function" ? key : () => key;

  const [data, setData] = signal<T | undefined>(initialData);
  const [isFetching, setIsFetching] = signal(false);
  const [error, setError] = signal<Error | undefined>(undefined);

  let abortController: AbortController | null = null;
  let disposed = false;
  let currentKey: string | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  const loading = derived(() => isFetching() && data() === undefined);
  const isStale = derived(() => {
    data();
    if (!currentKey) return true;
    const entry = queryCache.get(currentKey);
    if (!entry || entry.dataUpdatedAt === 0) return true;
    return Date.now() - entry.dataUpdatedAt >= staleTime;
  });

  async function doFetch(): Promise<void> {
    if (disposed || !currentKey || !enabled) return;
    const key = currentKey;
    let entry = queryCache.get(key);
    if (!entry) {
      entry = getOrCreateEntry(key);
      entry.subscribers++;
      entry.listeners.add(onCacheUpdate);
      entry.refetchers.add(doFetch);
    }

    // Dedup: another subscriber is already fetching this key — await its result
    if (entry.promise) {
      setIsFetching(true);
      try {
        await entry.promise;
      } catch {
        // Error handling is done by the original fetcher via listeners
      }
      // Sync state from cache entry after deduped fetch completes
      onCacheUpdate();
      return;
    }

    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;

    setIsFetching(true);

    const promise = withRetry(() => fetcher({ signal, key }), retryOptions, undefined, signal);
    entry.promise = promise;

    try {
      const result = await promise;
      entry.promise = null;
      if (disposed || currentKey !== key) return;

      entry.data = result;
      entry.dataUpdatedAt = Date.now();
      entry.error = undefined;

      const selected = select ? select(result as T) : (result as T);
      batch(() => {
        setData(selected);
        setIsFetching(false);
        setError(undefined);
      });

      for (const listener of entry.listeners) listener();
      onSuccess?.(result as T);
    } catch (err) {
      entry.promise = null;
      if (disposed || currentKey !== key) return;
      if (err instanceof DOMException && err.name === "AbortError") return;

      const errorObj = err instanceof Error ? err : new Error(String(err));
      entry.error = errorObj;

      batch(() => {
        setError(errorObj);
        setIsFetching(false);
      });

      for (const listener of entry.listeners) listener();
      onError?.(errorObj);
    } finally {
      if (!disposed && currentKey === key) onSettled?.();
    }
  }

  function onCacheUpdate(): void {
    if (disposed || !currentKey) return;
    const entry = queryCache.get(currentKey);
    if (!entry) {
      batch(() => {
        setData(undefined);
        setError(undefined);
        setIsFetching(false);
      });
      return;
    }
    const raw = entry.data as T | undefined;
    const selected = raw !== undefined && select ? select(raw) : raw;
    batch(() => {
      setData(selected);
      setError(entry.error);
      if (!entry.promise) setIsFetching(false);
    });
  }

  const effectCleanup = effect(() => {
    const key = resolveKey();

    if (currentKey !== null && currentKey !== key) {
      const oldEntry = queryCache.get(currentKey);
      if (oldEntry) {
        oldEntry.listeners.delete(onCacheUpdate);
        oldEntry.refetchers.delete(doFetch);
        oldEntry.subscribers--;
        if (oldEntry.subscribers <= 0 && cacheTime >= 0) {
          const oldKey = currentKey;
          oldEntry.gcTimer = setTimeout(() => queryCache.delete(oldKey), cacheTime);
        }
      }
    }

    currentKey = key;
    const entry = getOrCreateEntry(key, initialData);
    entry.subscribers++;
    if (entry.gcTimer !== null) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = null;
    }
    entry.listeners.add(onCacheUpdate);
    entry.refetchers.add(doFetch);

    if (entry.data !== undefined) {
      const raw = entry.data as T;
      const selected = select ? select(raw) : raw;
      batch(() => {
        setData(selected);
        setError(entry.error);
      });
    }

    const isDataStale = entry.dataUpdatedAt === 0 || Date.now() - entry.dataUpdatedAt >= staleTime;
    if (enabled && (entry.data === undefined || isDataStale)) {
      doFetch();
    }
  });

  if (refetchInterval && refetchInterval > 0) {
    intervalTimer = setInterval(() => {
      if (!disposed && currentKey && enabled) doFetch();
    }, refetchInterval);
  }

  let focusHandler: (() => void) | null = null;
  let onlineHandler: (() => void) | null = null;

  if (typeof globalThis !== "undefined" && typeof globalThis.addEventListener === "function") {
    if (refetchOnWindowFocus) {
      focusHandler = () => {
        if (!disposed && currentKey && enabled) doFetch();
      };
      globalThis.addEventListener("focus", focusHandler);
    }
    if (refetchOnReconnect) {
      onlineHandler = () => {
        if (!disposed && currentKey && enabled) doFetch();
      };
      globalThis.addEventListener("online", onlineHandler);
    }
  }

  function dispose(): void {
    disposed = true;
    abortController?.abort();
    effectCleanup();
    if (intervalTimer) clearInterval(intervalTimer);
    if (currentKey) {
      const entry = queryCache.get(currentKey);
      if (entry) {
        entry.listeners.delete(onCacheUpdate);
        entry.refetchers.delete(doFetch);
        entry.subscribers--;
        if (entry.subscribers <= 0 && cacheTime >= 0) {
          const key = currentKey;
          entry.gcTimer = setTimeout(() => queryCache.delete(key), cacheTime);
        }
      }
    }
    if (focusHandler) globalThis.removeEventListener("focus", focusHandler);
    if (onlineHandler) globalThis.removeEventListener("online", onlineHandler);
  }

  return {
    data,
    loading,
    fetching: isFetching,
    error,
    isStale,
    refetch: doFetch,
    dispose,
  };
}

/** Invalidate queries matching a key or predicate, triggering refetch for active subscribers */
export function invalidateQueries(keyOrPredicate: string | ((key: string) => boolean)): void {
  const predicate = typeof keyOrPredicate === "function" ? keyOrPredicate : (k: string) => k === keyOrPredicate;
  for (const [key, entry] of queryCache.entries()) {
    if (predicate(key)) {
      entry.dataUpdatedAt = 0;
      for (const refetcher of entry.refetchers) refetcher();
    }
  }
}

/** Get cached data for a query key */
export function getQueryData<T>(key: string): T | undefined {
  return queryCache.get(key)?.data as T | undefined;
}

/** Set cached data for a query key, notifying subscribers */
export function setQueryData<T>(key: string, data: T | ((prev: T | undefined) => T)): void {
  const entry = queryCache.get(key);
  if (!entry) return;
  const newData = typeof data === "function" ? (data as (prev: T | undefined) => T)(entry.data as T | undefined) : data;
  entry.data = newData;
  entry.dataUpdatedAt = Date.now();
  for (const listener of entry.listeners) listener();
}

/** Clear the entire query cache */
export function clearQueryCache(): void {
  const activeListeners: Array<() => void> = [];
  const activeRefetchers: Array<() => Promise<void>> = [];
  for (const entry of queryCache.values()) {
    if (entry.gcTimer) clearTimeout(entry.gcTimer);
    if (entry.subscribers > 0) {
      for (const listener of entry.listeners) activeListeners.push(listener);
      for (const refetcher of entry.refetchers) activeRefetchers.push(refetcher);
    }
  }
  queryCache.clear();
  for (const listener of activeListeners) listener();
  for (const refetcher of activeRefetchers) refetcher();
}
