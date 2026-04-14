import { signal } from "../core/signals/signal";

/**
 * Options for springSignal.
 */
export interface SpringOptions {
  /** Spring stiffness (0–1). Higher = snappier. Default: 0.15 */
  stiffness?: number;
  /** Damping ratio (0–1). Higher = less bouncy. Default: 0.8 */
  damping?: number;
  /** Precision threshold to stop the animation. Default: 0.01 */
  precision?: number;
}

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Creates a reactive spring-animated value. The getter returns the
 * current animated number (updated every frame via rAF). The setter
 * sets the target — the spring smoothly animates toward it using
 * physics simulation (stiffness + damping).
 *
 * Returns a `[getter, setter, dispose]` tuple.
 *
 * Respects `prefers-reduced-motion`: when enabled, snaps instantly
 * to the target with no animation.
 *
 * @param initial Starting value
 * @param options Spring physics parameters
 * @returns `[get, set, dispose]` — dispose cancels the animation loop
 *
 * @example
 * ```ts
 * const [x, setX, disposeSpring] = springSignal(0, { stiffness: 0.12, damping: 0.7 });
 *
 * // Animate to 200
 * setX(200);
 *
 * // Use in reactive binding
 * div({ style: { transform: () => `translateX(${x()}px)` } });
 *
 * // Cleanup when done
 * disposeSpring();
 * ```
 */
export function springSignal(
  initial: number,
  options?: SpringOptions,
): [get: () => number, set: (target: number) => void, dispose: () => void] {
  const stiffness = options?.stiffness ?? 0.15;
  const damping = options?.damping ?? 0.8;
  const precision = options?.precision ?? 0.01;

  const [value, setValue] = signal(initial);

  let current = initial;
  let velocity = 0;
  let target = initial;
  let rafId: number | null = null;
  let lastTime = 0;
  // Reference timestep (60 Hz) — coefficients are tuned at this rate so
  // the same `stiffness`/`damping` produce the same feel regardless of
  // monitor refresh rate. Clamped per-frame to avoid blow-ups after a
  // tab is throttled / backgrounded.
  const REF_DT_MS = 1000 / 60;
  const MAX_STEP_RATIO = 4; // never integrate more than 4 reference steps

  function tick(now: number): void {
    if (lastTime === 0) lastTime = now;
    const rawDt = now - lastTime;
    lastTime = now;
    // Guard against NaN/Infinity from broken rAF shims and clock skew.
    const dt = Number.isFinite(rawDt) && rawDt > 0 ? rawDt : REF_DT_MS;
    const ratio = Math.min(MAX_STEP_RATIO, Math.max(0.1, dt / REF_DT_MS));

    const force = -stiffness * (current - target);
    const dampingForce = -damping * velocity;
    velocity += (force + dampingForce) * ratio;
    current += velocity * ratio;

    if (Math.abs(current - target) < precision && Math.abs(velocity) < precision) {
      current = target;
      velocity = 0;
      rafId = null;
      lastTime = 0;
      setValue(current);
      return;
    }

    setValue(current);
    rafId = requestAnimationFrame(tick);
  }

  function set(newTarget: number): void {
    target = newTarget;

    // Snap immediately when reduced motion is preferred
    if (prefersReducedMotion()) {
      current = newTarget;
      velocity = 0;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      lastTime = 0;
      setValue(current);
      return;
    }

    // Start animation loop if not already running
    if (rafId === null) {
      lastTime = 0;
      rafId = requestAnimationFrame(tick);
    }
  }

  function dispose(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    lastTime = 0;
  }

  return [value, set, dispose];
}
