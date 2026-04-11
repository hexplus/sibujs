/**
 * Wait for the next microtask — after any currently-pending reactive updates
 * have been flushed. Useful in imperative code that needs to read DOM state
 * right after changing a signal.
 *
 * Under the hood this resolves on a microtask and again on an animation frame
 * so both synchronous reactive passes and layout side-effects have settled.
 *
 * @returns Promise that resolves after the next DOM flush
 *
 * @example
 * ```ts
 * setMenuOpen(true);
 * await nextTick();
 * menuRef.current?.focus(); // DOM has the new menu rendered
 * ```
 */
export function nextTick(): Promise<void> {
  return new Promise<void>((resolve) => {
    queueMicrotask(() => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
      } else {
        resolve();
      }
    });
  });
}
