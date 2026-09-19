import { adoptThenable } from "../../utils/adoptThenable";

type ErrorHandler = (error: unknown, context?: string) => void;

let globalErrorHandler: ErrorHandler | null = null;

/**
 * Wraps a function in a try/catch block with typed error handling.
 * Supports both sync and async functions (catches Promise rejections).
 *
 * @param fn Function to execute safely
 * @param onError Optional error handler (receives error and optional context)
 * @returns The function's return value, or null on error
 */
export function catchError<T>(fn: () => T, onError?: ErrorHandler): T | null {
  try {
    const result = fn();

    // Handle async — observe the rejection of any thenable. PromiseLike only
    // promises `then()`, so calling `.catch()` failed on a valid thenable (the
    // TypeError was reported as a sync failure and the real rejection was never
    // seen). adoptThenable reads `then` once and turns a throwing accessor into
    // a rejection.
    const adopted = adoptThenable(result);
    if (adopted) {
      adopted.then(undefined, (err: unknown) => {
        if (onError) {
          onError(err, "async");
        } else if (globalErrorHandler) {
          globalErrorHandler(err, "async");
        } else {
          console.error("Unhandled async error in Sibu.catchError:", err);
        }
      });
    }

    return result;
  } catch (err) {
    if (onError) {
      onError(err, "sync");
    } else if (globalErrorHandler) {
      globalErrorHandler(err, "sync");
    } else {
      console.error("Unhandled error in Sibu.catchError:", err);
    }
    return null;
  }
}

/**
 * Async version of catchError for explicit async/await usage.
 *
 * @param fn Async function to execute safely
 * @param onError Optional error handler
 * @returns Promise resolving to the result or null on error
 */
export async function catchErrorAsync<T>(fn: () => Promise<T>, onError?: ErrorHandler): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (onError) {
      onError(err, "async");
    } else if (globalErrorHandler) {
      globalErrorHandler(err, "async");
    } else {
      console.error("Unhandled async error in Sibu.catchErrorAsync:", err);
    }
    return null;
  }
}

/**
 * Sets a global error handler used by default if no onError is provided.
 */
export function setGlobalErrorHandler(handler: ErrorHandler) {
  globalErrorHandler = handler;
}
