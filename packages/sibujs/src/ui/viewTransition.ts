import { signal } from "@sibujs/core";

/**
 * viewTransition wraps the View Transitions API (document.startViewTransition).
 * Falls back to calling the callback directly when the API is unavailable.
 */
export function viewTransition(callback: () => void | Promise<void>): {
  start: () => Promise<void>;
  isTransitioning: () => boolean;
} {
  const [isTransitioning, setIsTransitioning] = signal(false);

  async function start(): Promise<void> {
    setIsTransitioning(true);
    try {
      if (
        typeof document !== "undefined" &&
        "startViewTransition" in document &&
        typeof (document as unknown as Record<string, unknown>).startViewTransition === "function"
      ) {
        const transition = (
          document as unknown as {
            startViewTransition: (cb: () => void | Promise<void>) => { finished: Promise<void> };
          }
        ).startViewTransition(callback);
        await transition.finished;
      } else {
        // Fallback: call callback directly
        await callback();
      }
    } finally {
      setIsTransitioning(false);
    }
  }

  return { start, isTransitioning };
}
