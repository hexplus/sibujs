import { createAbortError } from "./abort";

/**
 * Configurable retry strategies for async operations.
 * Used by `resource` and `query` for automatic error recovery.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts. Default: 3 */
  maxRetries?: number;
  /** Retry strategy. Default: "exponential" */
  strategy?: "exponential" | "linear" | "fixed";
  /** Base delay in ms. Default: 1000 */
  baseDelay?: number;
  /** Maximum delay in ms (caps exponential growth). Default: 30000 */
  maxDelay?: number;
  /** Jitter factor (0-1) to randomize delay. Default: 0.1 */
  jitter?: number;
  /** Predicate to decide if an error is retryable. Default: () => true */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
}

/**
 * Calculate delay for a given attempt based on strategy.
 */
export function calculateDelay(
  attempt: number,
  strategy: "exponential" | "linear" | "fixed",
  baseDelay: number,
  maxDelay: number,
  jitter: number,
): number {
  let delay: number;
  switch (strategy) {
    case "exponential":
      delay = baseDelay * 2 ** attempt;
      break;
    case "linear":
      delay = baseDelay * (attempt + 1);
      break;
    case "fixed":
      delay = baseDelay;
      break;
  }
  delay = Math.min(delay, maxDelay);
  // Cap delay before computing jitter so Infinity * jitter doesn't produce
  // NaN — that would cause setTimeout(fn, NaN) to fire immediately and
  // defeat backoff entirely.
  if (!Number.isFinite(delay)) delay = Number.MAX_SAFE_INTEGER;
  if (jitter > 0) {
    const jitterRange = delay * jitter;
    delay += (Math.random() * 2 - 1) * jitterRange;
  }
  if (!Number.isFinite(delay) || Number.isNaN(delay)) delay = 0;
  return Math.max(0, delay);
}

/**
 * Execute an async function with retry logic.
 * Returns the result or throws after all retries are exhausted.
 *
 * @param fn The async function to execute
 * @param options Retry configuration
 * @param onRetry Callback fired before each retry with error, attempt, and delay
 * @param signal AbortSignal to cancel retries
 *
 * @example
 * ```ts
 * const data = await withRetry(() => fetch("/api/data").then(r => r.json()), {
 *   maxRetries: 3,
 *   strategy: "exponential",
 *   shouldRetry: (err) => !(err instanceof TypeError),
 * });
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
  onRetry?: (error: unknown, attempt: number, delay: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const strategy = options?.strategy ?? "exponential";
  const baseDelay = options?.baseDelay ?? 1000;
  const maxDelay = options?.maxDelay ?? 30000;
  const jitter = options?.jitter ?? 0.1;
  const shouldRetry = options?.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw createAbortError();
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // CANCELLATION OUTRANKS RETRY POLICY.
      //
      // A rejection that arrives once the signal is already aborted is a
      // consequence of the cancellation, not an independent failure worth
      // retrying. Checking here — before `shouldRetry` and before `onRetry` —
      // is what stops a cancelled request from reporting a retry it will never
      // perform, and from waiting out a backoff nobody is waiting for.
      if (signal?.aborted) throw createAbortError();

      if (attempt >= maxRetries || !shouldRetry(error, attempt)) throw error;
      const delay = calculateDelay(attempt, strategy, baseDelay, maxDelay, jitter);
      onRetry?.(error, attempt, delay);
      await waitForRetryDelay(delay, signal);
    }
  }
  throw lastError;
}

/**
 * Sleep for the backoff, resolving on the timer and rejecting on abort.
 *
 * THE RACE THIS CLOSES: an `AbortSignal` does not replay a past `abort` event to
 * a listener registered afterwards. Attaching the listener without first testing
 * `signal.aborted` therefore meant an already-cancelled operation slept the full
 * backoff — up to `maxDelay` — before anything noticed. The guarantee here is
 * that there is no instant in which the signal can be aborted while neither an
 * `aborted` check nor a live listener can observe it: the state is tested before
 * the listener is attached AND again immediately after.
 *
 * Settles exactly once, and always removes the listener and clears the timer.
 */
function waitForRetryDelay(delay: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError());

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      action();
    };

    const onAbort = () => finish(() => reject(createAbortError()));
    const timer = setTimeout(() => finish(resolve), delay);

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      // Closes the window between the check above and this registration.
      if (signal.aborted) onAbort();
    }
  });
}
