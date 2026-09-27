import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";
import { batch } from "../reactivity/batch";
import { untracked } from "../reactivity/track";
import { isAbortError } from "./abort";
import { runCallback, runSelect } from "./callbacks";
import type { RetryOptions } from "./retry";
import { withRetry } from "./retry";
import { applyStructuralSharing, type StructuralSharingOption } from "./structuralSharing";

/**
 * Lifecycle callbacks follow the shared data-layer contract: an exception
 * thrown by `onStart`, `onSuccess`, `onError`, or `onSettled` never changes the
 * success/failure state of the fetch itself, and is reported separately via
 * `console.error`. See `QueryOptions` for the full statement.
 */
export interface ResourceOptions<T> {
  /** Initial data value before first fetch. Default: undefined */
  initialValue?: T;
  /** Retry options for failed fetches */
  retry?: RetryOptions;
  /** Whether to fetch immediately on creation. Default: true */
  immediate?: boolean;
  /** Called when a fetch starts */
  onStart?: () => void;
  /** Called on successful fetch */
  onSuccess?: (data: T) => void;
  /** Called on fetch error */
  onError?: (error: Error) => void;
  /** Called on fetch settle (success or error) */
  onSettled?: () => void;
  /**
   * Keep data referentially stable across refetches. Default: `true`.
   *
   * Each fetched result — from `refetch()` or a source change — is
   * reconciled against the value already held: a deeply equal result keeps
   * the previous reference and notifies nobody, and a partially changed one
   * reuses every unchanged nested object or array. Only plain objects and
   * arrays are compared; Date, Map, Set and class instances compare by
   * identity. Cyclic data is safe: the containers on a cycle are taken as-is.
   * Same contract as `QueryOptions.structuralSharing`.
   *
   * `mutate()` is an explicit write, not a fetch: when it hands over a new
   * top-level reference, `data` always becomes a new top-level reference and
   * notifies — even if every child is unchanged, as after
   * `prev.items.push(x); return { ...prev }`. Unchanged nested subtrees are
   * still reused beneath it.
   *
   * - `false` commits every result as-is.
   * - A function `(prev, next) => T` replaces the default reconciliation;
   *   return `prev` to report "unchanged" (ignored for a `mutate()` of a new
   *   reference). If it throws, the error is reported and `next` is committed
   *   unshared.
   */
  structuralSharing?: StructuralSharingOption<T>;
}

export interface Resource<T> {
  /** Reactive getter for the fetched data */
  data: () => T | undefined;
  /** Reactive getter for the loading state */
  loading: () => boolean;
  /** Reactive getter for the error state */
  error: () => Error | undefined;
  /** Manually trigger a refetch */
  refetch: () => Promise<void>;
  /** Mutate the cached data without refetching */
  mutate: (value: T | ((prev: T | undefined) => T)) => void;
  /** Abort the current in-flight request */
  abort: () => void;
  /** Cleanup all subscriptions and abort pending requests */
  dispose: () => void;
}

/**
 * Reactive async data primitive. Wraps a fetcher function and exposes
 * `data()`, `loading()`, `error()` signals.
 *
 * Overload 1: fetcher with no source signal (manual or immediate fetch).
 */
export function resource<T>(
  fetcher: (info: { signal: AbortSignal }) => Promise<T>,
  options?: ResourceOptions<T>,
): Resource<T>;

/**
 * Overload 2: fetcher with a reactive source signal.
 * Auto-refetches when the source changes.
 */
export function resource<T, S>(
  source: () => S,
  fetcher: (source: S, info: { signal: AbortSignal; prev: T | undefined }) => Promise<T>,
  options?: ResourceOptions<T>,
): Resource<T>;

export function resource<T, S = void>(
  sourceOrFetcher: (() => S) | ((info: { signal: AbortSignal }) => Promise<T>),
  fetcherOrOptions?:
    | ((source: S, info: { signal: AbortSignal; prev: T | undefined }) => Promise<T>)
    | ResourceOptions<T>,
  maybeOptions?: ResourceOptions<T>,
): Resource<T> {
  // Disambiguate overloads
  let source: (() => S) | null = null;
  let fetcher: (source: S, info: { signal: AbortSignal; prev: T | undefined }) => Promise<T>;
  let options: ResourceOptions<T>;

  if (typeof fetcherOrOptions === "function") {
    source = sourceOrFetcher as () => S;
    fetcher = fetcherOrOptions;
    options = maybeOptions ?? {};
  } else {
    const rawFetcher = sourceOrFetcher as (info: { signal: AbortSignal }) => Promise<T>;
    fetcher = (_source: S, info: { signal: AbortSignal; prev: T | undefined }) => rawFetcher(info);
    options = (fetcherOrOptions as ResourceOptions<T>) ?? {};
  }

  const [data, setData] = signal<T | undefined>(options.initialValue);
  const [loading, setLoading] = signal(false);
  const [error, setError] = signal<Error | undefined>(undefined);

  // Non-reactive data tracker to avoid registering deps inside effects
  let currentData: T | undefined = options.initialValue;

  /**
   * The only writer of `data`. A refetch used to commit a fresh reference even
   * when the payload was identical, so every binding over `data` re-ran and a
   * `when(() => r.data(), …)` branch rebuilt, discarding in-progress input.
   * Reconciling first makes an equal fetched result a no-op write; `explicit`
   * marks a `mutate()`, which must commit a new reference whenever it was given
   * one (see `applyStructuralSharing`). Untracked because `mutate()` may be
   * called from inside a caller's effect, and a custom sharing function must
   * not subscribe it.
   */
  function commitData(next: T, explicit: boolean): T {
    const sharing = options.structuralSharing ?? true;
    const shared = untracked(() =>
      runSelect("resource structuralSharing", () => applyStructuralSharing(sharing, currentData, next, explicit)),
    );
    currentData = shared.ok ? shared.value : next;
    setData(currentData);
    return currentData;
  }

  let abortController: AbortController | null = null;
  let disposed = false;
  let effectCleanup: (() => void) | null = null;
  let fetchVersion = 0;

  async function doFetch(sourceValue: S): Promise<void> {
    if (disposed) return;

    // Abort previous request
    abortController?.abort();
    abortController = new AbortController();
    const version = ++fetchVersion;
    const signal = abortController.signal;
    const prev = currentData;

    batch(() => {
      setLoading(true);
      setError(undefined);
    });
    // Isolated, and deliberately outside the try: an onStart that throws must
    // not cancel the fetch it was only meant to announce. `doFetch` is invoked
    // unawaited from an effect, so an escaping exception here became an
    // unhandled rejection rather than a catchable error.
    runCallback("resource onStart", () => options.onStart?.());

    try {
      const result = await withRetry(() => fetcher(sourceValue, { signal, prev }), options.retry, undefined, signal);

      // Guard against stale responses
      if (version !== fetchVersion || disposed) return;

      let committed: T = result;
      batch(() => {
        committed = commitData(result, false);
        setLoading(false);
      });
      // Isolated: the fetch succeeded and the data is committed. A throwing
      // onSuccess used to fall into the catch below, which then overwrote that
      // success with the callback's own error and invoked onError with it.
      runCallback("resource onSuccess", () => options.onSuccess?.(committed));
    } catch (err) {
      if (version !== fetchVersion || disposed) return;
      if (isAbortError(err)) {
        if (version === fetchVersion) setLoading(false);
        return;
      }

      const errorObj = err instanceof Error ? err : new Error(String(err));
      batch(() => {
        setError(errorObj);
        setLoading(false);
      });
      runCallback("resource onError", () => options.onError?.(errorObj));
    } finally {
      // `dispose()` aborts but does not bump `fetchVersion`, so the version check
      // alone would still run onSettled when the aborted (or abort-ignoring)
      // request settles — application code against a torn-down owner.
      if (!disposed && version === fetchVersion) {
        runCallback("resource onSettled", () => options.onSettled?.());
      }
    }
  }

  if (source) {
    // Auto-refetch when source changes
    effectCleanup = effect(() => {
      const sourceValue = (source as () => S)();
      doFetch(sourceValue);
    });
  } else if (options.immediate !== false) {
    // No source, fetch once immediately
    doFetch(undefined as S);
  }

  return {
    data,
    loading,
    error,
    refetch: () => doFetch(source ? source() : (undefined as S)),
    mutate: (value) => {
      const newValue = typeof value === "function" ? (value as (prev: T | undefined) => T)(currentData) : value;
      commitData(newValue, true);
    },
    abort: () => abortController?.abort(),
    dispose: () => {
      disposed = true;
      abortController?.abort();
      effectCleanup?.();
    },
  };
}
