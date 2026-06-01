/**
 * Animation hooks for SibuJS.
 * Provides declarative transition and spring animations for elements.
 */

export interface TransitionOptions {
  /** CSS property to animate (e.g., "opacity", "transform") */
  property?: string;
  /** Duration in milliseconds */
  duration?: number;
  /** CSS easing function */
  easing?: string;
  /** Delay before animation starts (ms) */
  delay?: number;
  /** CSS class to add during enter transition */
  enterClass?: string;
  /** CSS class to add during leave transition */
  leaveClass?: string;
  /** CSS class when element is active/visible */
  activeClass?: string;
  /** Callback when enter transition completes */
  onEnterDone?: () => void;
  /** Callback when leave transition completes */
  onLeaveDone?: () => void;
}

/**
 * transition provides enter/leave animation control for elements.
 * Returns functions to trigger enter and leave animations.
 *
 * @param element The target element to animate
 * @param options Transition configuration
 * @returns Object with enter() and leave() trigger functions
 *
 * @example
 * ```ts
 * const box = div("box", "Hello");
 * const { enter, leave } = transition(box, {
 *   duration: 300,
 *   enterClass: "fade-in",
 *   leaveClass: "fade-out",
 * });
 *
 * enter(); // Plays enter animation
 * leave(); // Plays leave animation
 * ```
 */
export function transition(
  element: HTMLElement,
  options: TransitionOptions = {},
): { enter: () => Promise<void>; leave: () => Promise<void> } {
  const {
    property = "all",
    duration = 300,
    easing = "ease",
    delay = 0,
    enterClass,
    leaveClass,
    activeClass,
    onEnterDone,
    onLeaveDone,
  } = options;

  const transitionValue = `${property} ${duration}ms ${easing} ${delay}ms`;
  let activeTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingResolve: (() => void) | null = null;

  function cancelPending(): void {
    if (activeTimer !== null) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    // Settle the superseded transition's promise so an interrupted
    // `await enter()`/`await leave()` never hangs forever. The completion
    // callback (onEnterDone/onLeaveDone) is intentionally NOT fired — the
    // transition was cancelled, not completed.
    if (pendingResolve !== null) {
      const resolvePrev = pendingResolve;
      pendingResolve = null;
      resolvePrev();
    }
  }

  function enter(): Promise<void> {
    return new Promise<void>((resolve) => {
      cancelPending();
      element.style.transition = transitionValue;

      if (enterClass) element.classList.add(enterClass);
      if (leaveClass) element.classList.remove(leaveClass);

      // Force reflow to ensure transition starts
      void element.offsetHeight;

      if (activeClass) element.classList.add(activeClass);

      const done = () => {
        activeTimer = null;
        pendingResolve = null;
        if (enterClass) element.classList.remove(enterClass);
        onEnterDone?.();
        resolve();
      };

      if (duration > 0) {
        pendingResolve = resolve;
        activeTimer = setTimeout(done, duration + delay);
      } else {
        done();
      }
    });
  }

  function leave(): Promise<void> {
    return new Promise<void>((resolve) => {
      cancelPending();
      element.style.transition = transitionValue;

      if (activeClass) element.classList.remove(activeClass);
      if (leaveClass) element.classList.add(leaveClass);
      if (enterClass) element.classList.remove(enterClass);

      const done = () => {
        activeTimer = null;
        pendingResolve = null;
        if (leaveClass) element.classList.remove(leaveClass);
        onLeaveDone?.();
        resolve();
      };

      if (duration > 0) {
        pendingResolve = resolve;
        activeTimer = setTimeout(done, duration + delay);
      } else {
        done();
      }
    });
  }

  return { enter, leave };
}

/**
 * Spring-like animation using Web Animations API.
 * Provides physics-based animation feel.
 *
 * @param element Element to animate
 * @param keyframes Animation keyframes
 * @param options Spring configuration
 * @returns Promise that resolves when animation completes
 *
 * @example
 * ```ts
 * await spring(box, [
 *   { transform: "scale(0.8)", opacity: 0 },
 *   { transform: "scale(1.05)", opacity: 1, offset: 0.7 },
 *   { transform: "scale(1)", opacity: 1 },
 * ], { duration: 400 });
 * ```
 */
export function spring(
  element: HTMLElement,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions = {},
): Promise<void> {
  const defaults: KeyframeAnimationOptions = {
    duration: 300,
    easing: "cubic-bezier(0.34, 1.56, 0.64, 1)",
    fill: "forwards",
  };

  return new Promise<void>((resolve) => {
    const animation = element.animate(keyframes, { ...defaults, ...options });
    animation.onfinish = () => resolve();
    animation.oncancel = () => resolve();
  });
}
