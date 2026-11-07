// ---------------------------------------------------------------------------
// One mapping from a style-map key to the CSS property it names.
//
// Every path that turns a key into a property name goes through here: the tag
// factory's static style maps, its per-property getters and its whole-`style`
// getters (including the bookkeeping that removes a property a later run no
// longer lists), the server DOM's `style.fooBar` property access, and the
// testing matchers. Two copies of this rule used to disagree — the client
// kebab-cased custom properties and had no `cssFloat` / `msX` handling, the
// server DOM had both — so the same component could set different properties
// depending on where it ran.
// ---------------------------------------------------------------------------

/** CSSOM camelCase names that do not kebab-case to their property. */
const EXCEPTIONS: Record<string, string> = { cssFloat: "float" };

/** A vendor prefix written without its leading dash (`msX` / `MsX` → `ms-x`). */
const VENDOR_PREFIX = /^(webkit|moz|ms|o)-/;

const cache = new Map<string, string>();
// Keys are property names, a small closed set in practice; the cap only guards
// against a whole-`style` getter whose keys come from unbounded data.
const CACHE_MAX = 1000;

/**
 * Convert a style-map key to the CSS property name it names.
 *
 * - A custom property (`--fooBar`) passes through untouched: custom property
 *   names are case-sensitive, so `--fooBar` and `--foo-bar` are different
 *   properties.
 * - CSSOM exceptions map to their property (`cssFloat` → `float`).
 * - camelCase becomes kebab-case (`backgroundColor` → `background-color`).
 * - A vendor prefix (`webkit`, `moz`, `ms`, `o`) gets its leading dash however
 *   it is capitalized: `msTransform` and `MsTransform` both become
 *   `-ms-transform`, `webkitLineClamp` and `WebkitLineClamp` both become
 *   `-webkit-line-clamp`.
 * - A key that is already a property name (`background-color`,
 *   `-webkit-line-clamp`) is returned unchanged.
 *
 * @param key A key of a `style` map, camelCase or kebab-case.
 * @returns The CSS property name to pass to `setProperty` / `removeProperty`.
 */
export function styleKeyToProperty(key: string): string {
  let name = cache.get(key);
  if (name !== undefined) return name;
  if (key.startsWith("--")) name = key;
  else if (Object.hasOwn(EXCEPTIONS, key)) name = EXCEPTIONS[key];
  else {
    name = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    if (VENDOR_PREFIX.test(name)) name = `-${name}`;
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, name);
  return name;
}
