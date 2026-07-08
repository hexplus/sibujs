import { signal } from "@sibujs/core";

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll"] as const;

/**
 * idle tracks user idle state based on mouse, keyboard, and touch activity.
 * Returns a reactive boolean that is true when the user has been idle
 * for the specified timeout duration.
 *
 * @param timeout Idle timeout in milliseconds (default: 60000)
 * @returns Object with reactive idle getter and dispose function for cleanup
 */
export function idle(timeout: number = 60000): { idle: () => boolean; dispose: () => void } {
  const [idle, setIdle] = signal(false);

  if (typeof window === "undefined" || typeof document === "undefined") {
    return { idle, dispose: () => {} };
  }

  let timer: ReturnType<typeof setTimeout> | null = null;

  function resetTimer() {
    setIdle(false);
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      setIdle(true);
    }, timeout);
  }

  for (const event of ACTIVITY_EVENTS) {
    document.addEventListener(event, resetTimer, { passive: true });
  }

  // Start the initial idle timer
  resetTimer();

  function dispose() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (const event of ACTIVITY_EVENTS) {
      document.removeEventListener(event, resetTimer);
    }
  }

  return { idle, dispose };
}
