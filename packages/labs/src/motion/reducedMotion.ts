import { signal } from "@sibujs/core";

/**
 * One-shot check of the `prefers-reduced-motion: reduce` media query. Returns
 * false under SSR / where `matchMedia` is unavailable. Use this for imperative
 * "should I animate right now?" decisions; use {@link reducedMotion} when you
 * need a value that reacts to the user changing the setting.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * reducedMotion returns a reactive boolean tracking whether the user
 * prefers reduced motion via the `prefers-reduced-motion` media query.
 */
export function reducedMotion(): { reduced: () => boolean; dispose: () => void } {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    const [reduced] = signal(false);
    return { reduced, dispose: () => {} };
  }

  const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
  const [reduced, setReduced] = signal(mql.matches);

  const handler = (event: MediaQueryListEvent) => {
    setReduced(event.matches);
  };

  mql.addEventListener("change", handler);

  function dispose() {
    mql.removeEventListener("change", handler);
  }

  return { reduced, dispose };
}
