import { signal } from "../signals/signal";

/**
 * Context API for SibuJS — provides dependency injection across
 * component trees without prop drilling.
 *
 * @example
 * ```ts
 * // Create a context with a default value
 * const ThemeContext = context("light");
 *
 * // Provide a value at a parent level
 * function App() {
 *   ThemeContext.provide("dark");
 *   return div({ nodes: [Child()] });
 * }
 *
 * // Consume the value anywhere below
 * function Child() {
 *   const theme = ThemeContext.use(); // reactive getter
 *   return div({ nodes: () => `Theme: ${theme()}` });
 * }
 * ```
 */

export interface Context<T> {
  /** Provide a value for this context. Overrides any parent provider. */
  provide(value: T): void;
  /** Get a reactive getter for the current context value. */
  use(): () => T;
  /** Get the current value directly (non-reactive). */
  get(): T;
  /** Update the provided value reactively. */
  set(value: T): void;
}

/**
 * Creates a new context with an optional default value.
 *
 * @param defaultValue The fallback value when no provider is found
 * @returns A Context object with provide, use, get, and set methods
 */
export function context<T>(defaultValue: T): Context<T> {
  const [getValue, setValue] = signal<T>(defaultValue);

  return {
    provide(value: T): void {
      setValue(value);
    },

    use(): () => T {
      return getValue;
    },

    get(): T {
      return getValue();
    },

    set(value: T): void {
      setValue(value);
    },
  };
}
