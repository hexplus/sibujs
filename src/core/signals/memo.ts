import { derived } from "./derived";
import type { Accessor } from "./signal";

/**
 * memo returns a memoized value that only recomputes when its
 * reactive dependencies change. This is semantically identical to
 * derived but named for convenience.
 *
 * Use this to avoid expensive computations on every render cycle.
 *
 * @param factory Function that computes the memoized value
 * @returns Getter function that returns the memoized value
 */
export function memo<T>(factory: () => T): Accessor<T> {
  return derived(factory);
}
