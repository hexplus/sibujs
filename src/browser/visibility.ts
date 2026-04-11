import { signal } from "../core/signals/signal";

/**
 * visibility tracks the document's Page Visibility state.
 * Returns a reactive boolean that is `true` while the tab is visible.
 *
 * Useful for pausing animations, polling, or video playback while the tab
 * is hidden — a common optimization to save CPU and battery.
 *
 * @returns Object with reactive `visible` getter and `dispose` function
 *
 * @example
 * ```ts
 * const { visible, dispose } = visibility();
 * effect(() => {
 *   if (visible()) resumePolling();
 *   else pausePolling();
 * });
 * ```
 */
export function visibility(): { visible: () => boolean; dispose: () => void } {
  if (typeof document === "undefined") {
    const [visible] = signal(true);
    return { visible, dispose: () => {} };
  }

  const [visible, setVisible] = signal(!document.hidden);

  const handler = () => setVisible(!document.hidden);
  document.addEventListener("visibilitychange", handler);

  function dispose() {
    document.removeEventListener("visibilitychange", handler);
  }

  return { visible, dispose };
}
