import { derived } from "@sibujs/core";
import { signal } from "@sibujs/core";
import { batch } from "@sibujs/core";
import type { RetryOptions } from "./retry";
import { withRetry } from "./retry";

export interface MutationOptions<TData, TVariables, TContext = unknown> {
  /** Retry options for failed mutations */
  retry?: RetryOptions;
  /** Called before mutation — return context for rollback in onError */
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

      options.onSuccess?.(result, variables, context as TContext);
      options.onSettled?.(result, undefined, variables, context);

      return result;
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));

      // A mutation aborted by reset()/supersession must not surface as an
      // error state — it was intentionally cancelled.
      if (errorObj instanceof DOMException && errorObj.name === "AbortError") throw errorObj;

      // Ignore stale errors — a newer mutate() call is in flight
      if (myRun !== runId) throw errorObj;

      batch(() => {
        setError(errorObj);
        setLoading(false);
        setStatus("error");
      });

      options.onError?.(errorObj, variables, context);
      options.onSettled?.(undefined, errorObj, variables, context);

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
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (typeof console !== "undefined") {
          console.warn("[SibuJS mutation] mutate() failed; check `.error()` signal or onError option.", err);
        }
      });
    },
    mutateAsync: execute,
    reset,
  };
}
