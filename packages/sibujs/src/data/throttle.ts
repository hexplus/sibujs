import { effect, signal } from "@sibujs/core";

/**
 * Returns a throttled reactive getter that updates at most once per `interval` ms.
 * Leading edge: first change propagates immediately.
 * Trailing edge: last change during cooldown propagates when cooldown ends.
 *
 * @param getter A reactive getter to throttle
 * @param interval Throttle interval in milliseconds
 * @returns A reactive getter for the throttled value
 *
 * @example
 * ```ts
 * const [scrollY, setScrollY] = signal(0);
 * const throttled = throttle(scrollY, 100);
 * // throttled() updates at most once every 100ms
 * ```
 */
export function throttle<T>(getter: () => T, interval: number): () => T {
  const [throttled, setThrottled] = signal<T>(getter());
  let cooldown = false;
  let pending: { value: T } | null = null;
  let lastEmitted: T = getter();
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Runs when a cooldown ends. Emits the trailing value (if any) and, crucially,
  // starts a fresh cooldown around that emission — otherwise a change arriving
  // right after the trailing emit would fire a leading edge less than `interval`
  // later, violating "at most once per interval".
  const onCooldownEnd = () => {
    if (pending !== null) {
      const trailingValue = pending.value;
      pending = null;
      setThrottled(trailingValue);
      lastEmitted = trailingValue;
      timer = setTimeout(onCooldownEnd, interval);
    } else {
      cooldown = false;
      timer = null;
    }
  };

  const stop = effect(() => {
    const value = getter();

    if (!cooldown) {
      // Leading edge: only fire and enter cooldown if value actually changed
      if (!Object.is(value, lastEmitted)) {
        setThrottled(value);
        lastEmitted = value;
        cooldown = true;
        pending = null;
        timer = setTimeout(onCooldownEnd, interval);
      }
    } else {
      // Inside cooldown: save latest value for trailing edge
      pending = { value };
    }
  });

  // Non-enumerable dispose (persist() convention): stop the subscription and
  // clear any pending cooldown timer so neither outlives the consumer.
  Object.defineProperty(throttled, "dispose", {
    value: () => {
      stop();
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    enumerable: false,
  });

  return throttled;
}
