// The id counter is shared across duplicate copies of this module (as a bundler
// can produce under dependency pre-bundling) via a globalThis registry. Without
// this, two copies would each count from 0 and hand out colliding ids like
// `sibu-1` — breaking a11y pairing (aria-labelledby / for+id) and SSR hydration.
// First copy creates the holder; later copies reuse it.
const COUNTER_KEY = Symbol.for("sibujs.createId.v1");
const _counter: { n: number } = ((globalThis as typeof globalThis & { [COUNTER_KEY]?: { n: number } })[COUNTER_KEY] ??=
  { n: 0 });

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
 *   return div([
 *     label({ for: id }, labelText),
 *     input({ id }),
 *   ]);
 * }
 * ```
 */
export function createId(prefix = "sibu"): string {
  _counter.n++;
  return `${prefix}-${_counter.n}`;
}

/**
 * Reset the id counter. Intended for tests and SSR setups that want
 * deterministic ids across runs.
 *
 * @internal
 */
export function __resetIdCounter(): void {
  _counter.n = 0;
}
