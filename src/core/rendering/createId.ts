import { getRequestStore } from "../ssr-context";

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
 * Inside an SSR request (`runInSSRContext`) the counter belongs to that request,
 * so every request's ids start from 1 — independent of earlier or concurrent
 * requests, and identical to a fresh client's sequence for hydration. Outside a
 * request the shared client counter is used.
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
  const request = getRequestStore();
  if (request) {
    request.idCounter = (request.idCounter ?? 0) + 1;
    return `${prefix}-${request.idCounter}`;
  }
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
