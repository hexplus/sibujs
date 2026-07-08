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

    // Handle async — catch Promise rejections
    if (result && typeof (result as unknown as Promise<unknown>).then === "function") {
      (result as unknown as Promise<unknown>).catch((err: unknown) => {
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
