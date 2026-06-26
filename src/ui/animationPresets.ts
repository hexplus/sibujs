/**
 * Animation presets for SibuJS.
 * Pre-built keyframe animations that work with the Web Animations API.
 * All presets respect reduced motion preferences.
 */

import { prefersReducedMotion } from "./reducedMotion";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AnimationPreset {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

export interface PresetOptions {
  duration?: number;
  easing?: string;
  delay?: number;
  fill?: FillMode;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createPreset(
  keyframes: Keyframe[],
  defaults: KeyframeAnimationOptions,
  overrides?: PresetOptions,
): AnimationPreset {
  const opts: KeyframeAnimationOptions = {
    ...defaults,
    ...overrides,
    fill: overrides?.fill ?? defaults.fill ?? "forwards",
  };

  // Respect reduced motion — collapse to instant
  if (prefersReducedMotion()) {
    return {
      keyframes: [keyframes[keyframes.length - 1]],
      options: { ...opts, duration: 0, delay: 0 },
    };
  }

  return { keyframes, options: opts };
}

function applyPreset(el: HTMLElement, preset: AnimationPreset): Promise<void> {
  return new Promise<void>((resolve) => {
    const anim = el.animate(preset.keyframes, preset.options);
    anim.onfinish = () => resolve();
    anim.oncancel = () => resolve();
  });
}

// ─── Fade ────────────────────────────────────────────────────────────────────

export function fadeIn(opts?: PresetOptions): AnimationPreset {
  return createPreset([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "ease-out" }, opts);
}

export function fadeOut(opts?: PresetOptions): AnimationPreset {
  return createPreset([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: "ease-in" }, opts);
}

// ─── Slide ───────────────────────────────────────────────────────────────────

export type SlideDirection = "up" | "down" | "left" | "right";

const slideOffsets: Record<SlideDirection, string> = {
  up: "translateY(20px)",
  down: "translateY(-20px)",
  left: "translateX(20px)",
  right: "translateX(-20px)",
};

export function slideIn(direction: SlideDirection = "up", opts?: PresetOptions): AnimationPreset {
  return createPreset(
    [
      { transform: slideOffsets[direction], opacity: 0 },
      { transform: "translate(0, 0)", opacity: 1 },
    ],
    { duration: 400, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    opts,
  );
}

export function slideOut(direction: SlideDirection = "down", opts?: PresetOptions): AnimationPreset {
  return createPreset(
    [
      { transform: "translate(0, 0)", opacity: 1 },
      { transform: slideOffsets[direction], opacity: 0 },
    ],
    { duration: 300, easing: "cubic-bezier(0.4, 0, 1, 1)" },
    opts,
  );
}

// ─── Scale ───────────────────────────────────────────────────────────────────

export function scaleUp(opts?: PresetOptions): AnimationPreset {
  return createPreset(
    [
      { transform: "scale(0.85)", opacity: 0 },
      { transform: "scale(1)", opacity: 1 },
    ],
    { duration: 350, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
    opts,
  );
}

export function scaleDown(opts?: PresetOptions): AnimationPreset {
  return createPreset(
    [
      { transform: "scale(1)", opacity: 1 },
      { transform: "scale(0.85)", opacity: 0 },
    ],
    { duration: 250, easing: "ease-in" },
    opts,
  );
}

// ─── Bounce ──────────────────────────────────────────────────────────────────

export function bounceIn(opts?: PresetOptions): AnimationPreset {
  return createPreset(
    [
      { transform: "scale(0.3)", opacity: 0 },
      { transform: "scale(1.05)", opacity: 0.8, offset: 0.5 },
      { transform: "scale(0.95)", opacity: 0.9, offset: 0.7 },
      { transform: "scale(1)", opacity: 1 },
    ],
    { duration: 500, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
    opts,
  );
}

export function bounceOut(opts?: PresetOptions): AnimationPreset {
  return createPreset(
    [
      { transform: "scale(1)", opacity: 1 },
      { transform: "scale(1.05)", opacity: 0.9, offset: 0.3 },
      { transform: "scale(0.3)", opacity: 0 },
    ],
    { duration: 400, easing: "ease-in" },
    opts,
  );
}

// ─── Flip ────────────────────────────────────────────────────────────────────

export function flipIn(axis: "x" | "y" = "x", opts?: PresetOptions): AnimationPreset {
  const prop = axis === "x" ? "rotateX" : "rotateY";
  return createPreset(
    [
      { transform: `perspective(400px) ${prop}(90deg)`, opacity: 0 },
      { transform: `perspective(400px) ${prop}(-10deg)`, opacity: 1, offset: 0.6 },
      { transform: `perspective(400px) ${prop}(0deg)`, opacity: 1 },
    ],
    { duration: 500, easing: "ease-out" },
    opts,
  );
}

// ─── Shake ───────────────────────────────────────────────────────────────────

export function shake(opts?: PresetOptions): AnimationPreset {
  return createPreset(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(-8px)", offset: 0.1 },
      { transform: "translateX(8px)", offset: 0.2 },
      { transform: "translateX(-6px)", offset: 0.3 },
      { transform: "translateX(6px)", offset: 0.4 },
      { transform: "translateX(-4px)", offset: 0.5 },
      { transform: "translateX(4px)", offset: 0.6 },
      { transform: "translateX(-2px)", offset: 0.7 },
      { transform: "translateX(0)" },
    ],
    { duration: 500, easing: "ease-out", fill: "none" },
    opts,
  );
}

// ─── Pulse ───────────────────────────────────────────────────────────────────

export function pulse(opts?: PresetOptions): AnimationPreset {
  return createPreset(
    [{ transform: "scale(1)" }, { transform: "scale(1.08)", offset: 0.5 }, { transform: "scale(1)" }],
    { duration: 400, easing: "ease-in-out", fill: "none" },
    opts,
  );
}

// ─── Orchestration ───────────────────────────────────────────────────────────

/**
 * Apply a preset to an element. Returns a promise that resolves when done.
 */
export function animate(el: HTMLElement, preset: AnimationPreset): Promise<void> {
  return applyPreset(el, preset);
}

/**
 * Apply a preset to multiple elements with staggered delay.
 */
export function stagger(elements: HTMLElement[], preset: AnimationPreset, delayBetween = 50): Promise<void> {
  const promises = elements.map((el, i) =>
    applyPreset(el, {
      keyframes: preset.keyframes,
      options: {
        ...preset.options,
        delay: ((preset.options.delay as number) || 0) + i * delayBetween,
      },
    }),
  );
  return Promise.all(promises).then(() => {});
}

/**
 * Run multiple animations in sequence.
 */
export async function sequence(steps: Array<{ el: HTMLElement; preset: AnimationPreset }>): Promise<void> {
  for (const step of steps) {
    await applyPreset(step.el, step.preset);
  }
}
