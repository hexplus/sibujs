import { signal } from "../core/signals/signal";

export interface AnimationFrameOptions {
  /** Maximum FPS. Frames that would exceed this are skipped. Default: unlimited. */
  fpsLimit?: number;
  /** Start immediately. Default: true. */
  immediate?: boolean;
}

/**
 * animationFrame emits a reactive `delta` (ms since previous frame) and
 * `elapsed` (ms since start) tracked via `requestAnimationFrame`. Useful for
 * declarative animations, game loops, or real-time visual updates — without
 * forcing callers to manage the rAF id manually.
 *
 * The loop is paused automatically when `pause()` is called and resumed with
 * `resume()`. `dispose()` cancels the loop permanently.
 *
 * @example
 * ```ts
 * const frame = animationFrame();
 * effect(() => {
 *   const dt = frame.delta();
 *   setAngle((a) => (a + dt * 0.1) % 360);
 * });
 * ```
 */
export function animationFrame(options: AnimationFrameOptions = {}): {
  delta: () => number;
  elapsed: () => number;
  running: () => boolean;
  pause: () => void;
  resume: () => void;
  dispose: () => void;
} {
  const [delta, setDelta] = signal(0);
  const [elapsed, setElapsed] = signal(0);
  const [running, setRunning] = signal(false);

  if (typeof requestAnimationFrame === "undefined") {
    return {
      delta,
      elapsed,
      running,
      pause: () => {},
      resume: () => {},
      dispose: () => {},
    };
  }

  let id: number | null = null;
  let prev = -1;
  let start = -1;
  let disposed = false;
  // Internal loop state, independent of the `running` signal. Every signal write
  // below runs subscribers synchronously, and a subscriber may pause, resume or
  // dispose the loop before the write returns — so control flow is decided from
  // these plain variables, re-checked after each publication, never from what
  // was true when the frame started.
  let active = false;
  // Bumped by every pause(), so a frame can tell that the timeline it was
  // publishing has been replaced (pause() + resume() from a subscriber).
  let generation = 0;
  const minFrameMs = options.fpsLimit ? 1000 / options.fpsLimit : 0;

  const step = (now: number) => {
    // This frame's id is consumed: nothing is queued until someone schedules.
    id = null;
    if (!active) return;
    const frameGeneration = generation;
    if (start < 0) start = now;
    const firstTick = prev < 0;
    const dt = firstTick ? 0 : now - prev;
    if (firstTick || dt >= minFrameMs) {
      // Commit bookkeeping before publishing, so a pause() from a subscriber
      // resets it rather than being overwritten afterwards.
      prev = now;
      const elapsedValue = now - start;
      setDelta(dt);
      if (!active || generation !== frameGeneration) return;
      setElapsed(elapsedValue);
      if (!active || generation !== frameGeneration) return;
    }
    // A subscriber may already have scheduled the next frame via resume().
    if (id === null) id = requestAnimationFrame(step);
  };

  function resume() {
    // `disposed` makes dispose() permanent — resume() can't restart the loop.
    if (disposed || active) return;
    active = true;
    id = requestAnimationFrame(step);
    // Published last: a subscriber reacting to `running` sees settled state.
    setRunning(true);
  }

  function pause() {
    generation++;
    active = false;
    if (id !== null) {
      cancelAnimationFrame(id);
      id = null;
    }
    prev = -1;
    start = -1;
    setRunning(false);
  }

  function dispose() {
    disposed = true;
    pause();
  }

  if (options.immediate !== false) resume();

  return { delta, elapsed, running, pause, resume, dispose };
}
