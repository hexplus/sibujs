let idCounter = 0;

/**
 * Generate a stable, framework-unique ID string suitable for a11y pairing
 * (`aria-labelledby`, `htmlFor` + `id`, etc.).
 *
 * Each call returns a fresh incrementing id. Optionally accepts a prefix.
 *
 * IDs are plain strings (not reactive) — call once per component instance
 * and reuse the returned value for both sides of the association.
 *
 * @param prefix Optional prefix, default "sibu"
 * @returns A unique id like `"sibu-1"` or `"my-input-2"`
 *
 * @example
 * ```ts
 * function Field(labelText: string) {
 *   const id = createId("field");
 *   return div({ nodes: [
 *     label({ for: id, nodes: labelText }),
 *     input({ id }),
 *   ]});
 * }
 * ```
 */
export function createId(prefix = "sibu"): string {
  idCounter++;
  return `${prefix}-${idCounter}`;
}

/**
 * Reset the id counter. Intended for tests and SSR setups that want
 * deterministic ids across runs.
 *
 * @internal
 */
export function __resetIdCounter(): void {
  idCounter = 0;
}
