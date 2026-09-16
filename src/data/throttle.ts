import { effect } from "../core/signals/effect";
import { type DisposableAccessor, signal } from "../core/signals/signal";

/**
 * Returns a throttled reactive getter that updates at most once per `interval` ms.
 * Leading edge: first change propagates immediately.
 * Trailing edge: last change during cooldown propagates when cooldown ends.
 *
 * @param getter A reactive getter to throttle
 * @param interval Throttle interval in milliseconds
 * @returns A reactive getter for the throttled value, with `dispose()` to stop
 *   tracking the source and clear the cooldown timer
 *
 * @example
 * ```ts
 * const [scrollY, setScrollY] = signal(0);
 * const throttled = throttle(scrollY, 100);
 * // throttled() updates at most once every 100ms
 * ```
 */
export function throttle<T>(getter: () => T, interval: number): DisposableAccessor<T> {
  const [throttled, setThrottled] = signal<T>(getter());
  let cooldown = false;
  let pending: { value: T } | null = null;
  let lastEmitted: T = getter();
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Every emission — leading OR trailing — opens a full cooldown window. The
  // trailing emission used to end the cooldown, so a change 1ms later emitted
  // immediately: two updates back-to-back despite "at most once per interval".
  function emit(value: T): void {
    setThrottled(value);
    lastEmitted = value;
    cooldown = true;
    pending = null;
    timer = setTimeout(endWindow, interval);
  }

  function endWindow(): void {
    timer = null;
    if (pending !== null && !Object.is(pending.value, lastEmitted)) {
      emit(pending.value);
      return;
    }
    pending = null;
    cooldown = false;
  }

  const stop = effect(() => {
    const value = getter();

    if (!cooldown) {
      // Leading edge: only fire and enter cooldown if value actually changed
      if (!Object.is(value, lastEmitted)) emit(value);
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

  return throttled as DisposableAccessor<T>;
}
