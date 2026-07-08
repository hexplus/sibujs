/**
 * vibrate triggers the Vibration API. Accepts a single duration in ms or
 * a pattern array alternating vibration and pause durations. Returns `true`
 * if the call was dispatched, `false` if the API is unsupported.
 *
 * Wrapped for consistency with the rest of `sibujs/browser` and to avoid
 * runtime errors on non-mobile browsers.
 *
 * @example
 * ```ts
 * vibrate(50);           // single 50ms tap
 * vibrate([100, 30, 100]); // pulse-pause-pulse
 * vibrate(0);            // cancel any active vibration
 * ```
 */
export function vibrate(pattern: number | number[]): boolean {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
    return false;
  }
  return navigator.vibrate(pattern);
}
