import { signal } from "@sibujs/core";

/**
 * media returns a reactive boolean that tracks whether a CSS media query matches.
 * Uses `window.matchMedia` and listens to `change` events for live updates.
 *
 * @param query CSS media query string (e.g. "(max-width: 768px)")
 * @returns Object with reactive matches getter and dispose function for cleanup
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
