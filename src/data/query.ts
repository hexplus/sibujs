import { derived } from "../core/signals/derived";
import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";
import { getRequestScopedCache } from "../core/ssr-context";
import { batch } from "../reactivity/batch";
import { globalSingleton } from "../utils/globalSingleton";
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
  /**
   * Cancellation for the in-flight request, owned by the ENTRY rather than by
   * whichever query instance happened to start it. Query instances are
   * observers: one losing interest must never cancel work another still needs
   * (QRY-001). Aborted only when the entry itself is abandoned — garbage
   * collected or cleared.
   */
  controller: AbortController | null;
  /**
   * Monotonic request generation for this entry. A result may commit only to
   * the generation that still owns the entry: the same key re-fetched after an
   * A→B→A round trip is a *different* generation, so key equality alone must
   * never grant commit permission (QRY-003).
   */
  generation: number;
}

// Process-global cache used on the client. Under SSR the cache must be
// request-scoped (via AsyncLocalStorage), otherwise one request's fetched
// data (e.g. user A's profile under key "profile") bleeds into a concurrent
// request for user B that resolves the same key. `getActiveQueryCache()`
// returns the request-scoped map under SSR and this global otherwise.
//
// Shared via globalSingleton so a bundler that duplicates this module doesn't
// give `query()` and `invalidateQueries`/`setQueryData` two separate caches.
const globalQueryCache = globalSingleton(Symbol.for("sibujs.query.cache.v1"), () => new Map<string, CacheEntry>());

function getActiveQueryCache(): Map<string, CacheEntry> {
  return getRequestScopedCache<CacheEntry>("query") ?? globalQueryCache;
}

/**
 * Recognise an abort across environments. `DOMException` is not guaranteed
 * everywhere a fetcher might run, and userland fetchers commonly reject with a
 * plain `{ name: "AbortError" }`.
 */
function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

/**
 * Abandon an entry's in-flight work — the entry is being discarded.
 *
 * Advancing the generation is what makes abandonment stick: a request already
 * in flight captured the old generation, so every ownership check downstream
 * (cache commit, local commit, onSettled) now sees it as superseded. Without
 * this, a request whose entry was cleared still looked like the owner, because
 * it holds a reference to the discarded entry object itself.
 */
function abandonEntry(entry: CacheEntry): void {
  if (entry.gcTimer) clearTimeout(entry.gcTimer);
  entry.gcTimer = null;
  entry.controller?.abort();
  entry.controller = null;
  entry.promise = null;
  entry.generation++;
}

function getOrCreateEntry(cache: Map<string, CacheEntry>, key: string, initialData?: unknown): CacheEntry {
  let entry = cache.get(key);
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
      controller: null,
      generation: 0,
    };
    cache.set(key, entry);
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

  // Bind this query instance to one cache map for its whole lifetime. Resolving
  // at creation (inside the request's SSR scope) keeps later async resolutions
  // writing to the same request-scoped map instead of leaking to the global.
  const cache = getActiveQueryCache();

  const [data, setData] = signal<T | undefined>(initialData);
  const [isFetching, setIsFetching] = signal(false);
  const [error, setError] = signal<Error | undefined>(undefined);

  let disposed = false;
  let currentKey: string | null = null;
  // The concrete CacheEntry this observer is currently attached to.
  //
  // Attachment must be keyed on ENTRY IDENTITY, not on the key string:
  // `clearQueryCache()` replaces the entry while the key stays the same, so
  // key-driven registration never re-runs and the observer silently detaches
  // (QRY-005). `same key !== same CacheEntry`.
  let attachedEntry: CacheEntry | null = null;
  let attachedKey: string | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  const loading = derived(() => isFetching() && data() === undefined);
  const isStale = derived(() => {
    data();
    if (!currentKey) return true;
    const entry = cache.get(currentKey);
    if (!entry || entry.dataUpdatedAt === 0) return true;
    return Date.now() - entry.dataUpdatedAt >= staleTime;
  });

  /**
   * Release this observer's registration on the entry it currently holds.
   *
   * GC is scheduled only when the entry is still the live one for its key —
   * scheduling it for an entry that has already been replaced would delete the
   * *replacement* out from under live observers.
   */
  function detachFromEntry(): void {
    const entry = attachedEntry;
    const key = attachedKey;
    if (!entry) return;

    attachedEntry = null;
    attachedKey = null;

    entry.listeners.delete(onCacheUpdate);
    entry.refetchers.delete(doFetch);
    // Never let the refcount go negative — a double-detach would otherwise
    // make the entry look abandoned while observers remain.
    entry.subscribers = Math.max(0, entry.subscribers - 1);

    if (entry.subscribers > 0 || cacheTime < 0 || key === null) return;
    if (cache.get(key) !== entry) return; // already replaced; nothing to collect

    if (entry.gcTimer !== null) clearTimeout(entry.gcTimer);
    entry.gcTimer = setTimeout(() => {
      const current = cache.get(key);
      // Re-check identity: a replacement entry must never be collected by a
      // timer scheduled for its predecessor.
      if (current === entry && current.subscribers <= 0) {
        abandonEntry(current);
        cache.delete(key);
      }
    }, cacheTime);
<<<<<<< HEAD
    // This timer is pure cleanup bookkeeping — nothing is waiting on it. Under
    // Node a ref'd handle would hold the event loop open for the whole
    // retention window (300 s by default), so an SSG build, a CLI, or a
    // serverless invocation that merely touched `query()` would hang long after
    // finishing its work. `unref()` changes only whether the timer keeps the
    // process alive, never when it fires. Browser timer handles have no
    // `unref`, hence the guard. (RC-002)
    (entry.gcTimer as { unref?: () => void }).unref?.();
=======
>>>>>>> main
  }

  /**
   * Attach this observer to `entry`, moving off any previous entry first.
   *
   * Idempotent: re-attaching to the entry already held is a no-op, so the
   * subscriber count can never be inflated by one observer.
   */
  function attachToEntry(entry: CacheEntry, key: string): void {
    if (attachedEntry === entry) {
      if (entry.gcTimer !== null) {
        clearTimeout(entry.gcTimer);
        entry.gcTimer = null;
      }
      return;
    }

    detachFromEntry();

    attachedEntry = entry;
    attachedKey = key;
    entry.subscribers++;
    entry.listeners.add(onCacheUpdate);
    entry.refetchers.add(doFetch);
    if (entry.gcTimer !== null) {
      clearTimeout(entry.gcTimer);
      entry.gcTimer = null;
    }
  }

  async function doFetch(): Promise<void> {
    if (disposed || !currentKey || !enabled) return;
    const key = currentKey;
    // getOrCreateEntry + attach on every fetch. After clearQueryCache() the
    // first refetcher recreates the entry and the rest deduplicate onto it, so
    // registering only on the create path left every other observer detached.
    const entry = getOrCreateEntry(cache, key);
    attachToEntry(entry, key);

    // Dedup: another subscriber is already fetching this key — await its result.
    // Capture the in-flight promise so a cache invalidation that swaps it
    // mid-await doesn't make us read entry.data/entry.error from the new fetch.
    if (entry.promise) {
      setIsFetching(true);
      const captured = entry.promise;
      try {
        await captured;
      } catch {
        // The owner records the outcome on the entry; a waiter only mirrors it.
      } finally {
        // Settle on EVERY terminal path. The previous version refreshed only
        // when `entry.promise === captured`, but the owner nulls `entry.promise`
        // before waiters resume — so that check was false on every normal
        // completion and waiters stayed `fetching` forever (QRY-002).
        // `onCacheUpdate()` is what clears the flag, so it must always run, and
        // it must run BEFORE the callbacks so they observe fresh state.
        if (!disposed && currentKey === key) {
          onCacheUpdate();
          if (entry.error) onError?.(entry.error);
          else if (entry.data !== undefined) onSuccess?.(entry.data as T);
          onSettled?.();
        }
      }
      return;
    }

    // The ENTRY owns cancellation. Starting a new request here must not abort
    // a request other observers are still awaiting; the previous request for
    // this entry has already settled (entry.promise was null above).
    entry.controller = new AbortController();
    const signal = entry.controller.signal;
    const generation = ++entry.generation;

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

      // Only the owning generation may clear the entry's in-flight state —
      // clearing first would let a stale settle wipe a newer request's promise
      // and abort handle.
      if (entry.generation !== generation) return;
      entry.promise = null;
      entry.controller = null;

      // ── Cache commit ───────────────────────────────────────────────────
      // Owned by the entry GENERATION, not by this observer. The instance that
      // started the request may since have changed key or been disposed, but
      // other observers are still waiting on the result — gating the cache
      // write on the initiator's local state stranded them with no data.
      entry.data = result;
      entry.dataUpdatedAt = Date.now();
      entry.error = undefined;

      // Notify every observer of the entry, including this one.
      for (const listener of entry.listeners) listener();

      // ── Local commit ───────────────────────────────────────────────────
      // Only if this observer still cares about this key.
      if (disposed || currentKey !== key) return;

      const selected = select ? select(result as T) : (result as T);
      batch(() => {
        setData(selected);
        setIsFetching(false);
        setError(undefined);
      });
      onSuccess?.(result as T);
    } catch (err) {
      if (entry.generation !== generation) return;
      entry.promise = null;
      entry.controller = null;

      if (isAbortError(err)) {
        // An abort is not an application error, but every observer still has
        // to leave the fetching state or it spins forever.
        for (const listener of entry.listeners) listener();
        if (!disposed && currentKey === key) setIsFetching(false);
        return;
      }

      const errorObj = err instanceof Error ? err : new Error(String(err));
      entry.error = errorObj;

      // Cache-level notification first — waiters depend on it.
      for (const listener of entry.listeners) listener();

      if (disposed || currentKey !== key) return;

      batch(() => {
        setError(errorObj);
        setIsFetching(false);
      });
      onError?.(errorObj);
    } finally {
      // Settlement is reported by the generation that owns the entry. A
      // superseded run must not tell this observer the work is done while a
      // newer request for the same key is still in flight.
      if (!disposed && currentKey === key && entry.generation === generation) onSettled?.();
    }
  }

  function onCacheUpdate(): void {
    if (disposed || !currentKey) return;
    const entry = cache.get(currentKey);
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
    const keyChanged = currentKey !== key;
    currentKey = key;

    // One call handles both transitions: a changed key, and an unchanged key
    // whose entry object was replaced. Detaching from the previous entry,
    // refcounting, and GC scheduling all live in the helpers.
    const entry = getOrCreateEntry(cache, key, initialData);
    attachToEntry(entry, key);

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
    // Deliberately does NOT abort: the in-flight request belongs to the cache
    // entry, and other observers may still need it (QRY-001). Abandoned
    // requests are cancelled when the entry itself is garbage collected.
    effectCleanup();
    if (intervalTimer) clearInterval(intervalTimer);
    detachFromEntry();
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
  for (const [key, entry] of getActiveQueryCache().entries()) {
    if (predicate(key)) {
      entry.dataUpdatedAt = 0;
      for (const refetcher of entry.refetchers) refetcher();
    }
  }
}

/** Get cached data for a query key */
export function getQueryData<T>(key: string): T | undefined {
  return getActiveQueryCache().get(key)?.data as T | undefined;
}

/** Set cached data for a query key, notifying subscribers */
export function setQueryData<T>(key: string, data: T | ((prev: T | undefined) => T)): void {
  const entry = getActiveQueryCache().get(key);
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
  const activeCache = getActiveQueryCache();
  for (const entry of activeCache.values()) {
    if (entry.subscribers > 0) {
      for (const listener of entry.listeners) activeListeners.push(listener);
      for (const refetcher of entry.refetchers) activeRefetchers.push(refetcher);
    }
    // Every entry is being discarded, so every request it owns is abandoned:
    // cancel it and advance its generation so a late settle cannot commit,
    // report settlement, or clobber the refetch started below.
    abandonEntry(entry);
  }
  activeCache.clear();
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
  const activeCache = getActiveQueryCache();
  for (const entry of activeCache.values()) {
    // Clearing discards every entry, so every request it owns is abandoned.
    // Cancel them rather than letting a stale result race the cleared cache.
    abandonEntry(entry);
  }
  activeCache.clear();
}
