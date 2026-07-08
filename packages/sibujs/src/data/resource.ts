import { effect } from "@sibujs/core";
import { signal } from "@sibujs/core";
import { batch } from "@sibujs/core";
import type { RetryOptions } from "./retry";
import { withRetry } from "./retry";

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
    options.onStart?.();

    try {
      const result = await withRetry(() => fetcher(sourceValue, { signal, prev }), options.retry, undefined, signal);

      // Guard against stale responses
      if (version !== fetchVersion || disposed) return;

      currentData = result;
      batch(() => {
        setData(result);
        setLoading(false);
      });
      options.onSuccess?.(result);
    } catch (err) {
      if (version !== fetchVersion || disposed) return;
      if (err instanceof DOMException && err.name === "AbortError") {
        if (version === fetchVersion) setLoading(false);
        return;
      }

      const errorObj = err instanceof Error ? err : new Error(String(err));
      batch(() => {
        setError(errorObj);
        setLoading(false);
      });
      options.onError?.(errorObj);
    } finally {
      if (version === fetchVersion) {
        options.onSettled?.();
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
      currentData = newValue;
      setData(newValue);
    },
    abort: () => abortController?.abort(),
    dispose: () => {
      disposed = true;
      abortController?.abort();
      effectCleanup?.();
    },
  };
}
