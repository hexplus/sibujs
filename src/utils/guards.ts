/**
 * Shared object-key guards.
 *
 * Centralized so every merge / reviver / patch path uses the SAME definition
 * of an unsafe key — preventing a prototype-pollution hole from re-appearing
 * because one new code path forgot a key or used `in` instead of an own check.
 */

// Keys that corrupt an object's prototype when assigned via bracket notation
// (`obj["__proto__"] = …` invokes the setter) or merged from untrusted JSON
// (where `__proto__`/`constructor`/`prototype` can be own enumerable keys).
const UNSAFE_KEYS = new Set<string>(["__proto__", "constructor", "prototype"]);

/** True for `__proto__` / `constructor` / `prototype`. */
export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

/**
 * Read a value the page stored on `window` as an OWN property — the only kind
 * a `<script>window.KEY = …</script>` assignment creates — or `undefined`.
 *
 * WHY NOT `window[KEY]`: named access on `window` also returns ELEMENTS. An
 * element rendered with `id="KEY"` (or a form / embed / image with `name="KEY"`)
 * is visible as `window.KEY` whenever the script did not run — a client-only
 * page, a CSP-blocked inline script, a cached shell — so user content could
 * hand the application a structured, truthy "server state" of its choosing
 * (DOM clobbering, CWE-1321-adjacent). Named properties live on the window's
 * prototype chain, never on the window itself, so an own-property read cannot
 * see them. A `Node` value is refused as well, as a second line.
 */
export function readOwnGlobal(key: string): unknown {
  if (typeof window === "undefined") return undefined;
  if (!Object.hasOwn(window, key)) return undefined;
  const value = (window as unknown as Record<string, unknown>)[key];
  if (typeof Node !== "undefined" && value instanceof Node) return undefined;
  return value;
}

/**
 * Shallow copy of `obj` with prototype-pollution keys removed. Use when merging
 * an untrusted patch into trusted state.
 */
export function stripUnsafeKeys<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj)) {
    if (!isUnsafeKey(k)) (out as Record<string, unknown>)[k] = (obj as Record<string, unknown>)[k];
  }
  return out;
}
