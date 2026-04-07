import { derived } from "./derived";
import type { Accessor } from "./signal";

/**
 * memoFn returns a memoized callback function that only updates
 * when its reactive dependencies change. This prevents unnecessary
 * re-creations of callback functions passed to child components.
 *
 * @param callback The callback function to memoize
 * @returns Getter that returns the current memoized callback
 */
export function memoFn<T extends (...args: any[]) => any>(callback: () => T): Accessor<T> {
  return derived(callback);
}
