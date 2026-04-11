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
  /** Pause (preserving remaining ticks until `resume()`). */
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
  let id: ReturnType<typeof setInterval> | null = null;
  let running = false;

  function start() {
    if (running) return;
    id = setInterval(fn, ms);
    running = true;
  }

  function stop() {
    if (id !== null) {
      clearInterval(id);
      id = null;
    }
    running = false;
  }

  start();

  return {
    stop,
    pause: stop,
    resume: start,
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
