/**
 * Declarative, disposable timers.
 *
 * The native `setInterval` / `setTimeout` are easy to leak if the owning
 * component is destroyed before they fire. These helpers return a handle
 * with a `stop()` function plus (for interval) `pause()` / `resume()`, and
 * optionally integrate with the sibujs disposal lifecycle through the
 * returned cleanup.
 *
 * Neither helper depends on any reactive context — they're pure JS with
 * nicer ergonomics for UIs that need to start and stop timers safely.
 */

export interface IntervalHandle {
  /** Stop the interval. Safe to call multiple times. */
  stop: () => void;
  /** Pause, preserving the time remaining until the next tick for `resume()`. */
  pause: () => void;
  /** Resume a paused interval. */
  resume: () => void;
  /** Whether the interval is currently running. */
  isRunning: () => boolean;
}

/**
 * Like `setInterval(fn, ms)` but returns a handle that can be stopped,
 * paused, and resumed without leaking closures.
 *
 * @example
 * ```ts
 * const tick = interval(() => setCount(c => c + 1), 1000);
 * // later
 * tick.pause();
 * tick.resume();
 * tick.stop();
 * ```
 */
export function interval(fn: () => void, ms: number): IntervalHandle {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  // One-shot timer used to finish a partially elapsed period after resume().
  let resumeId: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  // When the next tick is due, and how much of the period was left at pause().
  let nextDue = 0;
  let remaining = ms;

  function tick() {
    nextDue = Date.now() + ms;
    fn();
  }

  function clearTimers() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (resumeId !== null) {
      clearTimeout(resumeId);
      resumeId = null;
    }
  }

  function startRegular() {
    nextDue = Date.now() + ms;
    intervalId = setInterval(tick, ms);
  }

  function resume() {
    if (running) return;
    running = true;
    if (remaining >= ms) {
      startRegular();
      return;
    }
    // Finish the period that was interrupted, then continue on the regular
    // cadence. Restarting a full interval on every resume drifted each time.
    nextDue = Date.now() + remaining;
    resumeId = setTimeout(() => {
      resumeId = null;
      startRegular();
      fn();
    }, remaining);
  }

  function pause() {
    if (!running) return;
    remaining = Math.min(ms, Math.max(0, nextDue - Date.now()));
    clearTimers();
    running = false;
  }

  function stop() {
    clearTimers();
    running = false;
    // A stopped interval starts a full period if resumed.
    remaining = ms;
  }

  resume();

  return {
    stop,
    pause,
    resume,
    isRunning: () => running,
  };
}

export interface TimeoutHandle {
  /** Cancel the pending timeout. No-op if already fired. */
  cancel: () => void;
  /** Whether the callback has run or been cancelled. */
  isPending: () => boolean;
}

/**
 * Like `setTimeout(fn, ms)` but returns a handle with an explicit `cancel()`.
 *
 * @example
 * ```ts
 * const t = timeout(() => setVisible(false), 3000);
 * // cancel on user interaction
 * input({ on: { focus: () => t.cancel() } });
 * ```
 */
export function timeout(fn: () => void, ms: number): TimeoutHandle {
  let pending = true;
  const id = setTimeout(() => {
    pending = false;
    fn();
  }, ms);

  return {
    cancel: () => {
      if (pending) {
        clearTimeout(id);
        pending = false;
      }
    },
    isPending: () => pending,
  };
}
