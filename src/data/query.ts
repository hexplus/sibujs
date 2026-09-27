import { derived } from "../core/signals/derived";
import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";
import { getRequestScopedCache } from "../core/ssr-context";
import { batch } from "../reactivity/batch";
import { untracked } from "../reactivity/track";
import { globalSingleton } from "../utils/globalSingleton";
import { isAbortError } from "./abort";
import { notifyListeners, runCallback, runSelect } from "./callbacks";
import type { RetryOptions } from "./retry";
import { withRetry } from "./retry";
import { applyStructuralSharing, type StructuralSharingOption } from "./structuralSharing";

/**
 * ## Callback semantics
 *
 * These rules are shared by `query()`, `resource()`, `infiniteQuery()`, and
 * `mutation()`.
 *
 * **A callback exception is not an operation failure.** Exceptions thrown by
 * lifecycle callbacks (`onSuccess`, `onError`, `onSettled`, `onStart`) and by
 * `select` do not retroactively change the success/failure state of the
 * underlying request. A fetch that succeeded stays successful, its data stays
 * available, and the shared cache keeps the value it committed:
 *
 * ```text
 * network success → cache commit → onSuccess throws → still a success
 * ```
 *
 * **Callback errors are surfaced separately.** They are reported via
 * `console.error` (prefixed `[SibuJS data]`), never silently swallowed, and
 * never routed into the operation's own error channel — a throwing `onSuccess`
 * does not trigger `onError`, and does not populate `error()`.
 *
 * **Observers are isolated from each other.** Multiple observers sharing one
 * cache key are notified independently: one observer's `select` throwing cannot
 * prevent the others from receiving the shared result, and cannot poison the
 * shared cache entry.
 *
 * **A throwing `select` keeps the previous data.** `select` is the observer's
 * own transform, not part of the request. If it throws, this observer retains
 * whatever data it already had rather than committing a value that was never
 * produced; the request is still recorded as successful.
 *
 * **Ordering is guaranteed.** State is committed first, then `onSuccess` /
 * `onError`, then `onSettled`. `onSettled` runs even when the callback before
 * it threw.
 *
 * The one exception is `mutation()`'s `onMutate`, which is a step *of* the
 * mutation rather than a notification — see `MutationOptions.onMutate`.
 */
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
  /**
   * Transform fetched data before returning to consumers. Cache stores raw data.
   *
   * Runs in this observer's own reactive computation: it re-runs when the
   * cached value changes, and when a signal it reads changes — without
   * re-running the key effect, so such a signal never triggers a refetch. It
   * runs once per fetch that changed the data, and its output is structurally
   * shared against this observer's previous output for the same key, so an
   * identical refetch notifies nobody.
   */
  select?: (data: T) => T;
  /**
   * Keep data referentially stable across refetches. Default: `true`.
   *
   * Every refetch — `refetchInterval`, window focus, reconnect,
   * `invalidateQueries` — produces a new object graph even when the server
   * returned the same thing. With structural sharing on, the new result is
   * reconciled against the previous value of the same key: if it is deeply
   * equal the previous reference is kept and `data` subscribers are not
   * notified at all; if only part of it changed, every unchanged nested object
   * or array keeps its old reference, so `each()` rows and deriveds over
   * untouched branches stay put. Only plain objects and arrays are compared —
   * Date, Map, Set and class instances compare by identity. Cyclic data is
   * safe: the containers on a cycle are taken as-is.
   *
   * Every observer of a key using the default holds the SAME reference.
   *
   * `setQueryData()` is an explicit write, not a fetch: when it hands over a
   * new top-level reference, observers always receive a new top-level
   * reference and are notified — even if every child is unchanged, as after
   * `prev.items.push(x); return { ...prev }`. Unchanged nested subtrees are
   * still reused beneath it.
   *
   * The option applies to this observer only; observers of one key may use
   * different settings.
   *
   * - `false` commits every result as-is (each refetch notifies).
   * - A function `(prev, next) => T` replaces the default reconciliation;
   *   `prev` is this observer's previous value for the same key. Return `prev`
   *   to report "unchanged" (ignored for an explicit write of a new
   *   reference). It must not throw — if it does, the error is reported and
   *   `next` is committed unshared.
   *
   * Also applied to this observer's `select` output.
   */
  structuralSharing?: StructuralSharingOption<T>;
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
  /**
   * Whether `data` was WRITTEN by `setQueryData()` rather than fetched. An
   * explicit write of a new reference must reach observers as a new reference
   * (see `applyStructuralSharing`); a fetched result is fully shared.
   */
  explicit: boolean;
  /**
   * The default-shared view of `data`: what every observer using the default
   * `structuralSharing` holds, and what `getQueryData()` returns. Computed
   * lazily by `sharedView()` and memoized on the raw reference it was built
   * from (`sharedFrom`).
   *
   * `data` itself stays the raw value exactly as fetched or written. Sharing
   * is an observer setting, and the entry used to store the result of
   * whichever observer committed last — so an observer with
   * `structuralSharing: false` stopped being notified whenever a default
   * observer owned the refetch, and a custom function was applied on behalf of
   * every observer. Keeping the raw value lets each observer apply its own
   * setting; keeping ONE shared view per entry keeps every default observer of
   * a key on the same reference, and reconciles only against this key's own
   * previous value.
   */
  shared: unknown;
  sharedFrom: unknown;
  hasShared: boolean;
}

/**
 * Structural sharing that can never fail a commit. A throwing custom sharing
 * function is a callback exception, not a request failure (see "Callback
 * semantics" above): report it and commit `next` unshared. Untracked, so a
 * custom function reading a signal never subscribes whatever context the
 * commit happens to run in.
 */
function shareSafely<T>(option: StructuralSharingOption<T>, prev: T | undefined, next: T, explicit: boolean): T {
  const shared = untracked(() =>
    runSelect("query structuralSharing", () => applyStructuralSharing(option, prev, next, explicit)),
  );
  return shared.ok ? shared.value : next;
}

/** The entry's default-shared value; see `CacheEntry.shared`. */
function sharedView(entry: CacheEntry): unknown {
  const raw = entry.data;
  if (raw === undefined) return undefined;
  if (entry.hasShared && Object.is(entry.sharedFrom, raw)) return entry.shared;
  const value = shareSafely<unknown>(true, entry.hasShared ? entry.shared : undefined, raw, entry.explicit);
  entry.shared = value;
  entry.sharedFrom = raw;
  entry.hasShared = true;
  return value;
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
      explicit: false,
      shared: undefined,
      sharedFrom: undefined,
      hasShared: false,
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
    structuralSharing = true,
  } = options;

  const resolveKey = typeof key === "function" ? key : () => key;

  // Bind this query instance to one cache map for its whole lifetime. Resolving
  // at creation (inside the request's SSR scope) keeps later async resolutions
  // writing to the same request-scoped map instead of leaking to the global.
  const cache = getActiveQueryCache();

  const [data, setData] = signal<T | undefined>(initialData);
  const [isFetching, setIsFetching] = signal(false);
  const [error, setError] = signal<Error | undefined>(undefined);
  // Mirrors the entry's `dataUpdatedAt`. `isStale` used to recompute off
  // `data()` alone; with structural sharing an identical refetch no longer
  // touches `data`, and staleness would have stayed stuck at `true`.
  const [updatedAt, setUpdatedAt] = signal(0);

  // ── This observer's view of the cache ─────────────────────────────────────
  // `base` is the entry's value after THIS observer's sharing setting (see
  // `viewOf`), before `select`. Without `select` it is written straight to
  // `data`; with `select` it feeds the projection effect below.
  const [base, setBase] = signal<T | undefined>(undefined);
  // Non-reactive mirrors of `base` and the entry it was read from. Every memo
  // below is scoped to ONE entry: reconciling against a value committed for a
  // different key used to hand this observer subtrees of the previous key's
  // cache — breaking "every observer of a key holds the same reference", and
  // letting an in-place edit of one key's data leak into another's.
  let baseEntry: CacheEntry | null = null;
  let baseValue: T | undefined;
  // Set when `base` changed because of an explicit `setQueryData()`, so the
  // `select` output also commits a new top-level reference.
  let baseExplicit = false;
  // Custom `structuralSharing` memo: the last raw value it reconciled, for which
  // entry, and the result — so a re-notification with the same raw value does
  // not re-run the function.
  let customEntry: CacheEntry | null = null;
  let customFrom: unknown;
  let customValue: T | undefined;
  // `select` output memo, likewise scoped to the entry it was produced for.
  let selectedEntry: CacheEntry | null = null;
  let selectedValue: T | undefined;

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
    updatedAt();
    if (!currentKey) return true;
    const entry = cache.get(currentKey);
    if (!entry || entry.dataUpdatedAt === 0) return true;
    return Date.now() - entry.dataUpdatedAt >= staleTime;
  });

  /**
   * The entry's value as THIS observer sees it, per its own `structuralSharing`:
   *
   * - default → the entry's shared view, one reference for every default
   *   observer of the key;
   * - `false` → the raw value, so every fetch is a new reference and notifies;
   * - a function → applied to this observer's own previous value for the same
   *   entry, memoized on the raw reference.
   */
  function viewOf(entry: CacheEntry): T | undefined {
    const raw = entry.data as T | undefined;
    if (raw === undefined) return undefined;
    if (structuralSharing === false) return raw;
    if (typeof structuralSharing !== "function") return sharedView(entry) as T;
    const sameEntry = customEntry === entry;
    if (sameEntry && Object.is(customFrom, raw)) return customValue;
    const value = shareSafely(structuralSharing, sameEntry ? customValue : undefined, raw, entry.explicit);
    customEntry = entry;
    customFrom = raw;
    customValue = value;
    return value;
  }

  /**
   * The only writer of this observer's data. A value equal to what is already
   * held is the same reference (see `viewOf`), so the signal write is a no-op
   * and nothing downstream re-runs or rebuilds.
   */
  function commitBase(entry: CacheEntry | null, value: T | undefined): void {
    const changed = !Object.is(value, baseValue);
    baseEntry = entry;
    baseValue = value;
    if (!select) {
      setData(value);
      return;
    }
    if (!changed) return;
    baseExplicit = entry?.explicit === true;
    setBase(value);
  }

  // ── select ────────────────────────────────────────────────────────────────
  // A tracked computation of its own. `select` used to run inside the key
  // effect, where every signal it read became a key-effect dependency — an
  // unrelated signal change re-ran the staleness check and, for stale data,
  // refetched. Here a signal read by `select` re-runs the projection only.
  //
  // It runs when `base` changes — once per fetch that changed the data, never
  // again for a re-notification with the same value — and its output is shared
  // against this observer's previous output for the same entry, so a `select`
  // that builds a fresh object still notifies nobody for an identical refetch.
  const stopSelect = select
    ? effect(() => {
        const raw = base();
        const entry = baseEntry;
        const explicit = baseExplicit;
        baseExplicit = false;
        // Nothing committed yet: `data` still holds `initialData` as given.
        if (entry === null && selectedEntry === null) return;
        if (raw === undefined) {
          selectedEntry = entry;
          selectedValue = undefined;
          setData(undefined);
          return;
        }
        // A throwing `select` keeps the previous data (see "Callback
        // semantics"); the error is reported, never thrown into the effect.
        const selected = runSelect("query select", () => select(raw));
        if (!selected.ok) return;
        const prev = selectedEntry === entry ? selectedValue : undefined;
        const value = shareSafely(structuralSharing, prev, selected.value, explicit);
        selectedEntry = entry;
        selectedValue = value;
        setData(value);
      })
    : null;

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
    // This timer is pure cleanup bookkeeping — nothing is waiting on it. Under
    // Node a ref'd handle would hold the event loop open for the whole
    // retention window (300 s by default), so an SSG build, a CLI, or a
    // serverless invocation that merely touched `query()` would hang long after
    // finishing its work. `unref()` changes only whether the timer keeps the
    // process alive, never when it fires. Browser timer handles have no
    // `unref`, hence the guard. (RC-002)
    (entry.gcTimer as { unref?: () => void }).unref?.();
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
          // Isolated: this whole block sits in a `finally`, so an exception
          // here would escape doFetch() entirely — and doFetch() is called
          // unawaited from an effect, a timer, and window listeners, so it
          // would surface as an unhandled rejection rather than as anything a
          // caller could catch.
          if (entry.error) {
            const settledError = entry.error;
            runCallback("query onError", () => onError?.(settledError));
          } else if (entry.data !== undefined) {
            // The value this observer holds (before `select`), not the raw
            // one: with sharing on, an identical refetch reports the SAME
            // reference `data` kept.
            const settledData = viewOf(entry) as T;
            runCallback("query onSuccess", () => onSuccess?.(settledData));
          }
          runCallback("query onSettled", () => onSettled?.());
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
      // Classify before normalizing, like the async path below: normalization
      // discards `name`, and a cancellation that loses its name is
      // indistinguishable from an application failure.
      if (isAbortError(err)) return;
      const errorObj = err instanceof Error ? err : new Error(String(err));
      entry.error = errorObj;
      runCallback("query onError", () => onError?.(errorObj));
      runCallback("query onSettled", () => onSettled?.());
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
      //
      // Stored raw. Each observer applies its own sharing setting when it is
      // notified (`viewOf`), so a refetch returning what the cache already
      // holds leaves every sharing observer's `data` untouched.
      entry.data = result;
      entry.explicit = false;
      entry.dataUpdatedAt = Date.now();
      entry.error = undefined;

      // Notify every observer of the entry, including this one. Each is
      // isolated: one observer's `select` throwing must not stop the rest of
      // the observers from receiving a result the request genuinely produced.
      notifyListeners(entry.listeners, "query cache listener");

      // ── Local commit ───────────────────────────────────────────────────
      // Only if this observer still cares about this key.
      if (disposed || currentKey !== key) return;

      // This observer is one of the entry's listeners, so the notification
      // above has ALREADY committed its data, error and fetching state through
      // `onCacheUpdate`. It used to run `select` and `setData` a second time
      // here; with a `select` that builds a new object, that was a second
      // notification — and a second rebuild of anything keyed on `data` — for
      // every single fetch. Only an observer somehow not registered on the
      // entry still needs the commit done for it.
      if (!entry.listeners.has(onCacheUpdate)) onCacheUpdate();
      const committedResult = viewOf(entry) as T;
      runCallback("query onSuccess", () => onSuccess?.(committedResult));
    } catch (err) {
      if (entry.generation !== generation) return;
      entry.promise = null;
      entry.controller = null;

      if (isAbortError(err)) {
        // An abort is not an application error, but every observer still has
        // to leave the fetching state or it spins forever.
        notifyListeners(entry.listeners, "query cache listener");
        if (!disposed && currentKey === key) setIsFetching(false);
        return;
      }

      const errorObj = err instanceof Error ? err : new Error(String(err));
      entry.error = errorObj;

      // Cache-level notification first — waiters depend on it.
      notifyListeners(entry.listeners, "query cache listener");

      if (disposed || currentKey !== key) return;

      batch(() => {
        setError(errorObj);
        setIsFetching(false);
      });
      runCallback("query onError", () => onError?.(errorObj));
    } finally {
      // Settlement is reported by the generation that owns the entry. A
      // superseded run must not tell this observer the work is done while a
      // newer request for the same key is still in flight.
      //
      // Isolated for the same reason as the dedup path above: this is a
      // `finally`, so an escaping exception would leave doFetch() rejected with
      // no awaiter.
      if (!disposed && currentKey === key && entry.generation === generation) {
        runCallback("query onSettled", () => onSettled?.());
      }
    }
  }

  function onCacheUpdate(): void {
    if (disposed || !currentKey) return;
    const entry = cache.get(currentKey);
    if (!entry) {
      batch(() => {
        commitBase(null, undefined);
        setError(undefined);
        setIsFetching(false);
        setUpdatedAt(0);
      });
      return;
    }
    // `select` runs in its own effect after this batch, so a throwing `select`
    // can no longer block this observer's error/fetching bookkeeping.
    const view = viewOf(entry);
    batch(() => {
      commitBase(entry, view);
      setError(entry.error);
      if (!entry.promise) setIsFetching(false);
      setUpdatedAt(entry.dataUpdatedAt);
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
      const view = viewOf(entry);
      batch(() => {
        commitBase(entry, view);
        setError(entry.error);
        setUpdatedAt(entry.dataUpdatedAt);
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
    stopSelect?.();
    // The deriveds this observer owns: release their source edges and their
    // DevTools entries. A retained result keeps returning their last values.
    loading.dispose();
    isStale.dispose();
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

/**
 * Get cached data for a query key — the same reference every observer using
 * the default `structuralSharing` holds.
 */
export function getQueryData<T>(key: string): T | undefined {
  const entry = getActiveQueryCache().get(key);
  return entry ? (sharedView(entry) as T | undefined) : undefined;
}

/**
 * Set cached data for a query key, notifying subscribers.
 *
 * An explicit write: a value (or updater result) that is a new top-level
 * reference reaches every observer as a new top-level reference, even when it
 * is deeply equal to the previous value — so `prev.items.push(x); return
 * { ...prev }` is never dropped. Unchanged nested subtrees are still reused.
 * Returning `prev` itself changes nothing.
 */
export function setQueryData<T>(key: string, data: T | ((prev: T | undefined) => T)): void {
  const entry = getActiveQueryCache().get(key);
  if (!entry) return;
  const newData =
    typeof data === "function" ? (data as (prev: T | undefined) => T)(sharedView(entry) as T | undefined) : data;
  // Stored raw, like a fetch result; each observer applies its own sharing
  // setting, honouring `explicit` (see `applyStructuralSharing`).
  entry.data = newData;
  entry.explicit = true;
  entry.dataUpdatedAt = Date.now();
  // Isolated: a caller pushing data into the cache must reach every observer,
  // and must not have setQueryData() throw at them because some unrelated
  // observer's `select` rejects the new value.
  notifyListeners(entry.listeners, "query cache listener");
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
  notifyListeners(activeListeners, "query cache listener");
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
