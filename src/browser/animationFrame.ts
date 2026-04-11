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
  const minFrameMs = options.fpsLimit ? 1000 / options.fpsLimit : 0;

  const step = (now: number) => {
    if (start < 0) start = now;
    const firstTick = prev < 0;
    const dt = firstTick ? 0 : now - prev;
    if (firstTick || dt >= minFrameMs) {
      setDelta(dt);
      setElapsed(now - start);
      prev = now;
    }
    id = requestAnimationFrame(step);
  };

  function resume() {
    if (id !== null) return;
    setRunning(true);
    id = requestAnimationFrame(step);
  }

  function pause() {
    if (id !== null) {
      cancelAnimationFrame(id);
      id = null;
    }
    setRunning(false);
    prev = -1;
    start = -1;
  }

  function dispose() {
    pause();
  }

  if (options.immediate !== false) resume();

  return { delta, elapsed, running, pause, resume, dispose };
}
