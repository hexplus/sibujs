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
      entry.listeners.add(onCacheUpdate);
      entry.refetchers.add(doFetch);
    }

    // Dedup: another subscriber is already fetching this key — await its result.
    // Capture the in-flight promise so a cache invalidation that swaps it
    // mid-await doesn't make us read entry.data/entry.error from the new fetch.
    if (entry.promise) {
      setIsFetching(true);
      const captured = entry.promise;
      try {
        await captured;
        if (disposed || currentKey !== key) return;
        if (entry.promise === captured) {
          onCacheUpdate();
          if (entry.error) onError?.(entry.error);
          else if (entry.data !== undefined) onSuccess?.(entry.data as T);
        }
      } catch {
        if (disposed || currentKey !== key) return;
        if (entry.promise === captured) {
          onCacheUpdate();
          if (entry.error) onError?.(entry.error);
        }
      } finally {
        if (!disposed && currentKey === key) onSettled?.();
      }
      return;
    }

    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;

    setIsFetching(true);

    let promise: Promise<unknown>;
    try {
      promise = withRetry(() => fetcher({ signal, key }), retryOptions, undefined, signal);
    } catch (err) {
      // Synchronous throw from fetcher / withRetry — keep state consistent.
      setIsFetching(false);
      const errorObj = err instanceof Error ? err : new Error(String(err));
      entry.error = errorObj;
      onError?.(errorObj);
      onSettled?.();
      return;
    }
    entry.promise = promise as Promise<T>;

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
          // Clear any existing gcTimer before scheduling a new one so a
          // rapid key swap doesn't leave two timers racing toward the
          // same cache.delete(oldKey).
          if (oldEntry.gcTimer !== null) clearTimeout(oldEntry.gcTimer);
          oldEntry.gcTimer = setTimeout(() => queryCache.delete(oldKey), cacheTime);
        }
      }
    }

    const keyChanged = currentKey !== key;
    currentKey = key;
    const entry = getOrCreateEntry(key, initialData);
    if (keyChanged) entry.subscribers++;
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

    // Only fetch when the key actually changed (or on first mount). Fresh
    // data in-cache should not trigger a refetch storm when multiple
    // subscribers mount with the same key.
    if (!keyChanged && currentKey === key && entry.data !== undefined) {
      const isDataStale = entry.dataUpdatedAt === 0 || Date.now() - entry.dataUpdatedAt >= staleTime;
      if (enabled && isDataStale && !entry.promise) doFetch();
      return;
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
    // Idempotent: double-dispose previously decremented subscribers twice,
    // corrupting refcount and GC'ing entries still held by other subscribers.
    if (disposed) return;
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
          if (entry.gcTimer !== null) clearTimeout(entry.gcTimer);
          entry.gcTimer = setTimeout(() => queryCache.delete(key), cacheTime);
        }
      }
    }
    // Guard removeEventListener in case the runtime added addEventListener
    // to globalThis but doesn't expose removeEventListener symmetrically
    // (e.g. polyfilled-focus environments).
    if (focusHandler && typeof globalThis.removeEventListener === "function") {
      globalThis.removeEventListener("focus", focusHandler);
    }
    if (onlineHandler && typeof globalThis.removeEventListener === "function") {
      globalThis.removeEventListener("online", onlineHandler);
    }
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
  for (const refetcher of activeRefetchers) {
    refetcher().catch((err) => {
      if (typeof console !== "undefined") {
        console.warn("[SibuJS query] refetch after clearQueryCache failed:", err);
      }
    });
  }
}

/**
 * Test-only helper to drop every cache entry without invoking refetchers —
 * intended for afterEach hooks in test suites that reset the whole module
 * state between specs.
 *
 * @internal
 */
export function __resetQueryCache(): void {
  for (const entry of queryCache.values()) {
    if (entry.gcTimer) clearTimeout(entry.gcTimer);
  }
  queryCache.clear();
}
