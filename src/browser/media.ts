import { signal } from "../core/signals/signal";

/**
 * media tracks whether a CSS media query matches.
 * Uses `window.matchMedia` and listens to `change` events for live updates.
 *
 * It returns an object, not a bare `() => boolean`. The `change` listener stays
 * attached until `dispose()` is called, so a query created by a component must
 * be released with it (e.g. `onUnmount(dispose, el)`). After disposal `matches()`
 * keeps returning its last value.
 *
 * @example
 * ```ts
 * const { matches: small, dispose } = media("(max-width: 640px)");
 *
 * small();
 * dispose();
 * ```
 *
 * @param query CSS media query string (e.g. "(max-width: 768px)")
 * @returns `{ matches, dispose }` — a reactive getter and the listener release
 */
export function media(query: string): { matches: () => boolean; dispose: () => void } {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    const [matches] = signal(false);
    return { matches, dispose: () => {} };
  }

  const mql = window.matchMedia(query);
  const [matches, setMatches] = signal(mql.matches);

  const handler = (event: MediaQueryListEvent) => {
    setMatches(event.matches);
  };

  mql.addEventListener("change", handler);

  function dispose() {
    mql.removeEventListener("change", handler);
  }

  return { matches, dispose };
}
