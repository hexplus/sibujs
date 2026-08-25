import { devWarn, isDev } from "../dev";
import { signal } from "../signals/signal";
import { isSSR } from "../ssr-context";

const _isDev = isDev();

/**
 * Context API for SibuJS — a reactive global value that any component
 * can read without prop drilling.
 *
 * Note: this is a **global reactive store**, not a subtree-scoped DI
 * system. Calling `provide()` sets the value for ALL consumers, not
 * just descendants of the provider. For most apps this is sufficient
 * — use separate `context()` instances for independent scopes.
 *
 * @example
 * ```ts
 * // Create a context with a default value
 * const ThemeContext = context("light");
 *
 * // Set the value (global — affects all consumers)
 * ThemeContext.provide("dark");
 *
 * // Read reactively from any component
 * function Child() {
 *   const theme = ThemeContext.use(); // reactive getter
 *   return div(() => `Theme: ${theme()}`);
 * }
 * ```
 */

export interface Context<T> {
  /**
   * Set the context value globally. Affects all consumers.
   *
   * Returns a `restore` function that re-sets the context to the value it
   * had *before* this `provide` call. Useful for scoped overrides:
   *
   * ```ts
   * const restore = Theme.provide("dark");
   * try { renderChild(); } finally { restore(); }
   * ```
   *
   * Callers that don't need scoping can ignore the return value — existing
   * semantics are preserved.
   */
  provide(value: T): () => void;
  /** Get a reactive getter for the current context value. */
  use(): () => T;
  /** Get the current value directly (non-reactive). */
  get(): T;
  /** Update the provided value reactively. */
  set(value: T): void;
  /**
   * Run `fn` with the context temporarily set to `value`, then restore the
   * previous value (even if `fn` throws). Returns the result of `fn`.
   */
  withContext<R>(value: T, fn: () => R): R;
}

/**
 * Creates a new context with an optional default value.
 *
 * @param defaultValue The fallback value when no provider is found
 * @returns A Context object with provide, use, get, and set methods
 */
export function context<T>(defaultValue: T): Context<T> {
  const [getValue, setValue] = signal<T>(defaultValue);

  // Development-only guardrails. `context()` is an application-global reactive
  // value: it is neither subtree-scoped nor SSR request-scoped, which is a
  // surprise to anyone arriving from React/Vue/Solid. Rather than silently
  // producing cross-request data bleed, say so at the point of misuse.
  const warnIfSSR = (method: string): void => {
    if (!_isDev || !isSSR()) return;
    devWarn(
      `context.${method}() called during SSR. SibuJS context() is application-global — it is NOT ` +
        "isolated per request, so a concurrent request can observe this value. Do not use context() " +
        "for request-specific SSR data; pass it explicitly or use request-scoped storage instead.",
    );
  };

  const ctx: Context<T> = {
    provide(value: T): () => void {
      warnIfSSR("provide");
      const previous = getValue();
      setValue(value);
      return () => setValue(previous);
    },

    use(): () => T {
      return getValue;
    },

    get(): T {
      return getValue();
    },

    set(value: T): void {
      warnIfSSR("set");
      setValue(value);
    },

    withContext<R>(value: T, fn: () => R): R {
      warnIfSSR("withContext");
      const previous = getValue();
      setValue(value);
      try {
        const result = fn();
        // The restore below runs in `finally` — i.e. when `fn` RETURNS, not
        // when a promise it returned settles. Scoping therefore covers only the
        // synchronous portion of an async callback. Deliberately not "fixed"
        // with a promise-aware restore: because the value is global, that would
        // still not isolate overlapping async scopes, and would merely make the
        // hazard harder to see. See docs/architecture/context.md.
        if (_isDev && result !== null && typeof (result as { then?: unknown })?.then === "function") {
          devWarn(
            "context.withContext() received an async callback. Scoping is synchronous only — the " +
              "previous value is restored as soon as the callback returns its promise, so anything " +
              "after an `await` runs outside the scope.",
          );
        }
        return result;
      } finally {
        setValue(previous);
      }
    },
  };

  return ctx;
}
