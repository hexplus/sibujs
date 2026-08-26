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
  /** Manually re-run the async computation. No-op after `dispose()`. */
  refresh: () => void;
  /**
   * Stop the derivation permanently: unsubscribe from every tracked source,
   * abort the in-flight run, and ignore any promise that resolves afterwards.
   *
   * Idempotent. An `asyncDerived` created inside a component or route must be
   * disposed when that scope tears down — otherwise it stays subscribed to its
   * sources for the lifetime of the page and keeps re-running.
   */
  dispose: () => void;
}

/** Per-run context handed to the factory. */
export interface AsyncDerivedContext {
  /**
   * Aborted when a newer run supersedes this one, or when the derivation is
   * disposed. Forward it to `fetch` (or any abortable API) to cancel work that
   * can no longer affect the result.
   */
  signal: AbortSignal;
}

/**
 * `asyncDerived` is the async counterpart of `derived`: it takes a factory
 * that returns a Promise and re-runs whenever its reactive dependencies
 * change. The returned object exposes reactive `value`, `loading`, and
 * `error` getters, plus a `refresh()` trigger.
 *
 * Stale responses are dropped: if a new run starts before an older one
 * resolves, the older one's result is ignored. This prevents flicker when
 * dependencies change rapidly (e.g. typing in a search box). The superseded
 * run's `AbortSignal` is also aborted, so abortable work (e.g. `fetch`) is
 * cancelled rather than merely ignored. The run-id guard is retained
 * regardless, because not every async API honours `AbortSignal` — aborting
 * alone does not close the stale-completion race.
 *
 * ## Dependency tracking and `await`
 *
 * Reactive reads are tracked **synchronously**, so only the reads that happen
 * BEFORE the factory's first `await` become dependencies:
 *
 * ```ts
 * asyncDerived(async () => {
 *   const a = sourceA();      // tracked — runs synchronously
 *   await something();
 *   const b = sourceB();      // NOT tracked — the tracking context is gone
 * });
 * ```
 *
 * This is a property of synchronous tracking, not a bug: SibuJS does not
 * install async-context machinery to follow reads across suspension points.
 * Read every dependency up front (before the first `await`) if the derivation
 * must react to it, or call `refresh()` explicitly.
 *
 * ## Ownership
 *
 * `asyncDerived` subscribes to its sources until `dispose()` is called. It is
 * not attached to an enclosing scope automatically — dispose it from the
 * owning component's cleanup.
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
export function asyncDerived<T>(
  factory: (context: AsyncDerivedContext) => Promise<T>,
  initial: T,
): AsyncDerivedState<T> {
  const [value, setValue] = signal<T>(initial);
  const [loading, setLoading] = signal(false);
  const [error, setError] = signal<unknown | null>(null);
  const [tick, setTick] = signal(0);

  let runId = 0;
  let disposed = false;
  // Controller for the run currently in flight, so a superseding run or a
  // dispose can cancel it rather than just discarding its result.
  let controller: AbortController | null = null;

  const abortInFlight = (): void => {
    if (controller === null) return;
    const c = controller;
    controller = null;
    try {
      c.abort();
    } catch {
      // An environment with a non-conforming AbortController must not be able
      // to break teardown.
    }
  };

  const stopEffect = effect(() => {
    tick(); // track so `refresh()` re-runs
    if (disposed) return;

    // Supersede the previous run before starting a new one.
    abortInFlight();
    const currentRun = ++runId;
    const ac = typeof AbortController !== "undefined" ? new AbortController() : null;
    controller = ac;

    batch(() => {
      setLoading(true);
      setError(null);
    });

    // `stale` covers both races at once: a newer run having started, and the
    // whole derivation having been disposed. A promise that settles after
    // either must not write state — that is what makes disposal final.
    const stale = (): boolean => disposed || currentRun !== runId;

    let promise: Promise<T>;
    try {
      promise = factory({ signal: ac ? ac.signal : (undefined as unknown as AbortSignal) });
    } catch (err) {
      if (stale()) return;
      batch(() => {
        setError(err);
        setLoading(false);
      });
      return;
    }

    promise.then(
      (result) => {
        if (stale()) return;
        controller = null;
        batch(() => {
          setValue(result);
          setLoading(false);
        });
      },
      (err) => {
        if (stale()) return;
        controller = null;
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
    refresh: () => {
      if (disposed) return;
      setTick((n) => n + 1);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Unsubscribe FIRST so a source that changes during teardown cannot
      // schedule another run, then cancel whatever is still in flight.
      stopEffect();
      abortInFlight();
    },
  };
}
