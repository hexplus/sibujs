import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";

/**
 * Tracks the previous value of a reactive signal.
 * Returns `undefined` on first read (there is no previous value yet).
 *
 * @param getter A reactive getter to track
 * @returns A reactive getter for the previous value
 *
 * @example
 * ```ts
 * const [count, setCount] = signal(0);
 * const prev = previous(count);
 * prev(); // undefined
 * setCount(5);
 * prev(); // 0
 * setCount(10);
 * prev(); // 5
 * ```
 */
export function previous<T>(getter: () => T): () => T | undefined {
  const [previous, setPrevious] = signal<T | undefined>(undefined);
  let current = getter();

  const stop = effect(() => {
    const next = getter();
    if (!Object.is(next, current)) {
      setPrevious(current);
      current = next;
    }
  });

  // Non-enumerable dispose (persist() convention) so callers can release the
  // source subscription on unmount instead of leaking it for the page lifetime.
  Object.defineProperty(previous, "dispose", {
    value: stop,
    enumerable: false,
  });

  return previous;
}
