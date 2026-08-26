/**
 * Cancellation classification for the data layer.
 *
 * INTERNAL — not exported from the `sibujs/data` barrel. One definition so that
 * the same rejected value means the same thing to every primitive.
 *
 * Before this existed there were three different classifiers in the data layer:
 * `resource` and `mutation` accepted only `DOMException`, while `query` and
 * `infiniteQuery` accepted any object carrying `name === "AbortError"`. The same
 * cancelled fetcher was therefore silently ignored by one primitive and stored
 * as application error state by another.
 */

/**
 * Is this rejection a cancellation?
 *
 * Deliberately permissive about the CARRIER and strict about the SIGNAL:
 *
 *  - `DOMException`, a real `Error`, and a plain `{ name: "AbortError" }` all
 *    count. `DOMException` is not available in every runtime a user's fetcher
 *    might execute in, and userland fetchers commonly reject with a plain
 *    object — behaviour `query()` and `infiniteQuery()` already documented, so
 *    narrowing to `Error` here would have regressed a published contract.
 *  - Classification is by `name`, never by message. `new Error("AbortError")`
 *    has `name === "Error"` and stays an ordinary application error.
 */
export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/**
 * The cancellation error the runtime itself raises.
 *
 * Prefers `DOMException` so it is indistinguishable from what `fetch` produces
 * on abort, and falls back to a correctly-named `Error` in runtimes without it
 * (older Node, some workers/edge environments).
 */
export function createAbortError(message = "Aborted"): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException(message, "AbortError");
  }
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
