import { effect } from "@sibujs/core";

// Module-level storage for debug values
const debugValues: Array<{ value: unknown; label: string }> = [];

/**
 * Registers a reactive value for DevTools inspection.
 * Uses an effect internally to track changes — the formatter is called
 * on every update, and the latest snapshot is stored for DevTools.
 *
 * @param value Reactive getter (e.g., a signal)
 * @param formatter Optional function to convert value to a display label
 * @returns Dispose function to stop tracking
 */
export function debugValue<T>(value: () => T, formatter?: (value: T) => string): () => void {
  const format = formatter ?? ((v: T) => String(v));
  const entry = { value: undefined as unknown, label: "" };
  debugValues.push(entry);

  const dispose = effect(() => {
    const resolved = value();
    entry.value = resolved;
    // A throwing formatter (or String() on a Symbol) must not kill the effect
    // and stop tracking — fall back to a safe label.
    try {
      entry.label = format(resolved);
    } catch (err) {
      entry.label = `<format error: ${err instanceof Error ? err.message : String(err)}>`;
    }
  });

  return () => {
    dispose();
    const idx = debugValues.indexOf(entry);
    if (idx !== -1) debugValues.splice(idx, 1);
  };
}

/**
 * Returns all currently registered debug values.
 */
export function getDebugValues(): Array<{ value: unknown; label: string }> {
  return [...debugValues];
}

/**
 * Clears all registered debug values.
 */
export function clearDebugValues(): void {
  debugValues.length = 0;
}
