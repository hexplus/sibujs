import { signal } from "./signal";

/**
 * ref creates a mutable reference object with a reactive `current` property.
 *
 * Reading `.current` tracks the dependency (like a signal getter).
 * Writing `.current` notifies subscribers (like a signal setter).
 * This makes ref compatible with APIs that take reactive getters,
 * such as resize(), draggable(), and dropZone().
 *
 * Common uses:
 * - Storing DOM element references (works with tagFactory's ref prop)
 * - Holding mutable values with optional reactivity
 * - Imperative API handles (e.g., focus, scroll)
 *
 * @param initial Optional initial value for the ref
 * @returns An object with a reactive `current` property
 */
export interface Ref<T> {
  current: T;
}

export function ref<T>(initial: T): Ref<T>;
export function ref<T = undefined>(): Ref<T | undefined>;
export function ref<T>(initial?: T): Ref<T | undefined> {
  const [get, set] = signal<T | undefined>(initial);
  return {
    get current(): T | undefined {
      return get();
    },
    set current(value: T | undefined) {
      set(value);
    },
  };
}
