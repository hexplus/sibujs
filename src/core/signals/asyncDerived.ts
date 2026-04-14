import { batch } from "../../reactivity/batch";
import { effect } from "./effect";
import { signal } from "./signal";

export interface AsyncDerivedState<T> {
  /** Resolved value, or `initial` while loading. */
  value: () => T;
  /** True while the underlying promise is in-flight. */
  loading: () => boolean;
  /** The last caught error, or `null`. */
  error: () => unknown | null;
  /** Manually re-run the async computation. */
  refresh: () => void;
}

/**
 * `asyncDerived` is the async counterpart of `derived`: it takes a factory
 * that returns a Promise and re-runs whenever its reactive dependencies
 * change. The returned object exposes reactive `value`, `loading`, and
 * `error` getters, plus a `refresh()` trigger.
 *
 * Stale responses are dropped: if a new run starts before an older one
 * resolves, the older one's result is ignored. This prevents flicker when
 * dependencies change rapidly (e.g. typing in a search box).
 *
 * Unlike `query()` or `resource()`, `asyncDerived` has no caching or retry
 * logic — it's a minimal async-reactivity primitive suited for ad-hoc
 * derivations (parsing, formatting, validation against a server).
 *
 * @param factory Async function returning the derived value
 * @param initial Value used while the first computation is pending
 *
 * @example
 * ```ts
 * const [query, setQuery] = signal("");
 * const results = asyncDerived(async () => {
 *   const q = query();
 *   if (!q) return [];
 *   const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
 *   return r.json();
 * }, []);
 * ```
 */
export function asyncDerived<T>(factory: () => Promise<T>, initial: T): AsyncDerivedState<T> {
  const [value, setValue] = signal<T>(initial);
  const [loading, setLoading] = signal(false);
  const [error, setError] = signal<unknown | null>(null);
  const [tick, setTick] = signal(0);

  let runId = 0;

  effect(() => {
    tick(); // track so `refresh()` re-runs
    const currentRun = ++runId;
    batch(() => {
      setLoading(true);
      setError(null);
    });

    let promise: Promise<T>;
    try {
      promise = factory();
    } catch (err) {
      batch(() => {
        setError(err);
        setLoading(false);
      });
      return;
    }

    promise.then(
      (result) => {
        if (currentRun !== runId) return; // stale
        batch(() => {
          setValue(result);
          setLoading(false);
        });
      },
      (err) => {
        if (currentRun !== runId) return; // stale
        batch(() => {
          setError(err);
          setLoading(false);
        });
      },
    );
  });

  return {
    value,
    loading,
    error,
    refresh: () => setTick((n) => n + 1),
  };
}
