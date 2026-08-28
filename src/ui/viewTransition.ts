import { signal } from "../core/signals/signal";

/**
 * viewTransition wraps the View Transitions API (document.startViewTransition).
 * Falls back to calling the callback directly when the API is unavailable.
 *
 * OVERLAP MODEL — aggregate in-flight state.
 *
 * `isTransitioning` used to be a plain boolean set true on entry and false in a
 * `finally`, which makes it a claim owned by whichever run settled last rather
 * than a description of the controller. Two overlapping starts raced over it:
 *
 *     start A → pending
 *     start B → pending
 *     B finishes  →  isTransitioning() === false, while A is still running
 *
 * so the UI dropped its transition affordance — spinner, pointer-events guard,
 * whatever it gates — in the middle of a transition that was still going.
 *
 * The flag now describes the aggregate: it becomes true when the first run
 * starts, stays true while at least one run is in flight, and becomes false
 * exactly when the final one settles, in any settlement order. A rejection is a
 * settlement like any other, so one run failing does not clear the flag while
 * another is still running — and every caller still receives its own resolution
 * or rejection, unchanged.
 *
 * Native transitions are deliberately NOT serialized here. The browser's own
 * API defines what happens when a second transition starts while one is active
 * (it skips the older one), and queueing on top of that would delay callbacks
 * the caller expects to have run. This wrapper reports state; it does not
 * impose a scheduling policy the platform already has.
 */
export function viewTransition(callback: () => void | Promise<void>): {
  start: () => Promise<void>;
  isTransitioning: () => boolean;
} {
  const [isTransitioning, setIsTransitioning] = signal(false);
  /** How many runs are in flight. The flag is `inflight > 0`, always. */
  let inflight = 0;

  async function start(): Promise<void> {
    inflight++;
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
      // Guaranteed decrement — a synchronous throw from `callback`, a rejected
      // `finished`, and a normal return all arrive here. Clamped at zero so a
      // hypothetical double-settle can never leave the counter negative, which
      // would latch the flag on forever.
      inflight--;
      if (inflight <= 0) {
        inflight = 0;
        setIsTransitioning(false);
      }
    }
  }

  return { start, isTransitioning };
}
