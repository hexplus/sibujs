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
 * Shallow copy of `obj` with prototype-pollution keys removed. Use when merging
 * an untrusted patch into trusted state.
 */
export function stripUnsafeKeys<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj)) {
    if (!isUnsafeKey(k)) (out as Record<string, unknown>)[k] = (obj as Record<string, unknown>)[k];
  }
  return out;
}
