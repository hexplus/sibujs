import { derived } from "../core/signals/derived";
import { signal } from "../core/signals/signal";
import { batch } from "../reactivity/batch";
import { isAbortError } from "./abort";
import { runCallback } from "./callbacks";
import type { RetryOptions } from "./retry";
import { withRetry } from "./retry";

/**
 * Lifecycle callbacks follow the shared data-layer contract: an exception
 * thrown by `onSuccess`, `onError`, or `onSettled` never changes the status of
 * the mutation itself — a mutation that succeeded stays `success` and
 * `mutateAsync` still resolves — and is reported separately via
 * `console.error`. See `QueryOptions` for the full statement.
 *
 * `onMutate` is the deliberate exception; see its own note below.
 */
export interface MutationOptions<TData, TVariables, TContext = unknown> {
  /** Retry options for failed mutations */
  retry?: RetryOptions;
  /**
   * Called before the mutation — return context for rollback in `onError`.
   *
   * Unlike the notification callbacks, `onMutate` is a **step of** the
   * mutation: it produces the rollback context everything downstream depends
   * on. If it throws, the mutation fails — there is no context, and the
   * optimistic update it was meant to apply never happened.
   */
  onMutate?: (variables: TVariables) => TContext | Promise<TContext>;
  /** Called on successful mutation */
  onSuccess?: (data: TData, variables: TVariables, context: TContext) => void;
  /** Called on mutation error — context from onMutate available for rollback */
  onError?: (error: Error, variables: TVariables, context: TContext | undefined) => void;
  /** Called on mutation settle (success or error) */
  onSettled?: (
    data: TData | undefined,
    error: Error | undefined,
    variables: TVariables,
    context: TContext | undefined,
  ) => void;
}

export interface MutationResult<TData, TVariables> {
  /** Reactive getter for the mutation result data */
  data: () => TData | undefined;
  /** Reactive getter for the loading state */
  loading: () => boolean;
  /** Reactive getter for the error state */
  error: () => Error | undefined;
  /** Reactive getter: true if mutation succeeded */
  isSuccess: () => boolean;
  /** Reactive getter: true if mutation has not been called */
  isIdle: () => boolean;
  /** Fire-and-forget mutation trigger */
  mutate: (variables: TVariables) => void;
  /** Mutation trigger that returns a promise */
  mutateAsync: (variables: TVariables) => Promise<TData>;
  /** Reset state to idle */
  reset: () => void;
}

export function mutation<TData, TVariables = void, TContext = unknown>(
  mutationFn: (variables: TVariables, signal?: AbortSignal) => Promise<TData>,
  options: MutationOptions<TData, TVariables, TContext> = {},
): MutationResult<TData, TVariables> {
  const [data, setData] = signal<TData | undefined>(undefined);
  const [loading, setLoading] = signal(false);
  const [error, setError] = signal<Error | undefined>(undefined);
  const [status, setStatus] = signal<"idle" | "loading" | "success" | "error">("idle");

  const isSuccess = derived(() => status() === "success");
  const isIdle = derived(() => status() === "idle");

  let runId = 0;
  let abortController: AbortController | null = null;

  async function execute(variables: TVariables): Promise<TData> {
    // Abort any in-flight mutation (incl. its retry chain) before starting a
    // new one, so a superseding mutate() doesn't leave a zombie retry loop.
    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;
    const myRun = ++runId;
    let context: TContext | undefined;

    batch(() => {
      setLoading(true);
      setError(undefined);
      setStatus("loading");
    });

    try {
      // `onMutate` is deliberately NOT isolated. Unlike the notification
      // callbacks below, it is a step *of* the operation: it produces the
      // rollback context the rest of the mutation depends on. If it throws
      // there is no context, the optimistic update it was meant to apply did
      // not happen, and treating that as a mutation failure is correct.
      if (options.onMutate) {
        context = await options.onMutate(variables);
      }

      // Pass the signal both to withRetry (stops scheduling further retries
      // once aborted) and to mutationFn (lets the caller cancel the request).
      const result = await withRetry(() => mutationFn(variables, signal), options.retry, undefined, signal);

      // Ignore stale responses — a newer mutate() call is in flight
      if (myRun !== runId) return result;

      batch(() => {
        setData(result);
        setLoading(false);
        setStatus("success");
      });

      // Isolated. The mutation itself succeeded — that is what decides the
      // status. Previously a throwing onSuccess fell into the catch below,
      // which flipped the already-committed "success" state to "error", called
      // onError with the callback's error, and rejected mutateAsync.
      //
      // Order is pinned: state commit → onSuccess → onSettled. onSettled runs
      // even when onSuccess throws.
      runCallback("mutation onSuccess", () => options.onSuccess?.(result, variables, context as TContext));
      runCallback("mutation onSettled", () => options.onSettled?.(result, undefined, variables, context));

      return result;
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));

      // A mutation aborted by reset()/supersession must not surface as an
      // error state — it was intentionally cancelled.
      if (isAbortError(errorObj)) throw errorObj;

      // Ignore stale errors — a newer mutate() call is in flight
      if (myRun !== runId) throw errorObj;

      batch(() => {
        setError(errorObj);
        setLoading(false);
        setStatus("error");
      });

      // Isolated. The failure that gets reported and rethrown is the
      // mutation's own — a throwing onError must not replace it, nor skip
      // onSettled. Order is pinned: state commit → onError → onSettled.
      runCallback("mutation onError", () => options.onError?.(errorObj, variables, context));
      runCallback("mutation onSettled", () => options.onSettled?.(undefined, errorObj, variables, context));

      throw errorObj;
    }
  }

  function reset(): void {
    runId++;
    // Cancel any in-flight mutation + its pending retries.
    abortController?.abort();
    abortController = null;
    batch(() => {
      setData(undefined);
      setError(undefined);
      setLoading(false);
      setStatus("idle");
    });
  }

  return {
    data,
    loading,
    error,
    isSuccess,
    isIdle,
    mutate: (variables: TVariables) => {
      // The error is already surfaced via the reactive `error` signal and
      // options.onError — but keep a devWarn so fire-and-forget mutate()
      // failures aren't completely invisible when onError isn't wired.
      execute(variables).catch((err) => {
        // An abort (reset()/supersession) is intentional — don't warn for it.
        if (isAbortError(err)) return;
        if (typeof console !== "undefined") {
          console.warn("[SibuJS mutation] mutate() failed; check `.error()` signal or onError option.", err);
        }
      });
    },
    mutateAsync: execute,
    reset,
  };
}
