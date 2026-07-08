import { effect } from "@sibujs/core";
import { signal } from "@sibujs/core";

/**
 * Returns a debounced reactive getter that only updates after `delay` ms
 * of inactivity from the source signal.
 *
 * @param getter A reactive getter to debounce
 * @param delay Debounce delay in milliseconds
 * @returns A reactive getter for the debounced value
 *
 * @example
 * ```ts
 * const [search, setSearch] = signal("");
 * const debouncedSearch = debounce(search, 300);
 * // debouncedSearch() only updates 300ms after the last setSearch call
 * ```
 */
export function debounce<T>(getter: () => T, delay: number): () => T {
  const [debounced, setDebounced] = signal<T>(getter());
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = effect(() => {
    const value = getter();
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      setDebounced(value);
      timer = null;
    }, delay);
  });

  // Expose a non-enumerable `dispose` (same convention as persist()) so callers
  // can stop the source subscription and cancel the pending timer on unmount,
  // instead of leaking both for the page's lifetime.
  Object.defineProperty(debounced, "dispose", {
    value: () => {
      stop();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    enumerable: false,
  });

  return debounced;
}
