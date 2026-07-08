import { effect } from "@sibujs/core";

/**
 * lazyEffect creates an effect that only activates when the target element
 * becomes visible in the viewport (via IntersectionObserver). When the element
 * leaves the viewport, the effect is disposed. When it re-enters, the effect
 * is re-created.
 *
 * Use for large grids/lists where you want reactive bindings only on visible
 * elements (e.g., a 10,000-cell spreadsheet with only ~50 active effects).
 *
 * @param element The element to observe for visibility
 * @param effectFn The effect function to run when visible
 * @param options IntersectionObserver options (root, rootMargin, threshold)
 * @returns Dispose function to stop observing and clean up
 *
 * @example
 * ```ts
 * const cell = document.createElement("td");
 * lazyEffect(cell, () => {
 *   cell.textContent = display(); // only reactive when visible
 * });
 * ```
 */
export function lazyEffect(element: HTMLElement, effectFn: () => void, options?: IntersectionObserverInit): () => void {
  if (typeof IntersectionObserver === "undefined") {
    // Fallback: always active (SSR or old browser)
    const dispose = effect(effectFn);
    return dispose;
  }

  let dispose: (() => void) | null = null;
  let disposed = false;

  const observer = new IntersectionObserver(
    (entries) => {
      if (disposed) return;
      const entry = entries[0];
      if (!entry) return;

      if (entry.isIntersecting && !dispose) {
        // Element became visible — activate the effect
        dispose = effect(effectFn);
      } else if (!entry.isIntersecting && dispose) {
        // Element left viewport — deactivate the effect
        dispose();
        dispose = null;
      }
    },
    { threshold: 0, ...options },
  );

  observer.observe(element);

  return () => {
    disposed = true;
    observer.disconnect();
    if (dispose) {
      dispose();
      dispose = null;
    }
  };
}
