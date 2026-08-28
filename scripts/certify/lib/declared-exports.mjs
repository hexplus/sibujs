// ---------------------------------------------------------------------------
// Exact export-name extraction for generated `.d.ts` / `.d.cts` files.
//
// WHY THIS EXISTS AS ITS OWN MODULE
// ---------------------------------
// The certification gate checks that no framework-internal helper is declared
// in the public declarations. It used to do that with
//
//     new RegExp(`\b${name}\b`)
//
// which never matched anything: inside a template literal `\b` is the BACKSPACE
// character (U+0008), not the word-boundary assertion — the constructor
// received /\x08getRequestStore\x08/. The check therefore passed on a
// declaration that really did export the internal, which is the worst failure
// mode a gate can have: silent, and indistinguishable from success.
//
// It also inspected only the slice after the LAST `export {`, so a leak in one
// of the `export { … } from './chunk.js'` blocks tsup emits at the top of every
// declaration file was outside the text it looked at.
//
// Rather than repair the regex, the names are extracted structurally and
// compared as exact identifiers. This module is deliberately side-effect free
// and dependency free so the meta-test can import the detector without running
// the audit — importing the gate itself would try to resolve an installed
// package from the consumer project and exit the process.
// ---------------------------------------------------------------------------

/** `export { … }`, `export type { … }`, with or without a `from` clause. */
const EXPORT_CLAUSE = /\bexport\s*(?:type\s+)?\{([^}]*)\}/g;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Blank out comments and string literals so neither can be mistaken for code.
 *
 * A declaration file may legitimately mention an internal in prose — the audit
 * inspects what is EXPORTED, so `// export { getRequestStore }` must not count,
 * and neither must a string literal type containing the same text.
 *
 * @param {string} source
 * @returns {string}
 */
function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      i++;
      while (i < source.length && source[i] !== char) {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      out += '""';
      continue;
    }

    out += char;
    i++;
  }
  return out;
}

/**
 * Every identifier named by an `export { … }` clause in a declaration file.
 *
 * BOTH sides of a rename are collected. For `export { getRequestStore as gr }`
 * the public NAME is `gr`, but the internal's value is still published, which is
 * the semver commitment the gate exists to catch; for `export { x as
 * getRequestStore }` the public name itself collides with the internal. Either
 * is worth failing on, and no legitimate public symbol is named after an
 * internal, so collecting both costs nothing.
 *
 * @param {string} source contents of a `.d.ts` or `.d.cts` file
 * @returns {Set<string>} exact identifiers, never substrings
 */
export function declaredExportNames(source) {
  const names = new Set();
  const code = stripCommentsAndStrings(source);

  for (const match of code.matchAll(EXPORT_CLAUSE)) {
    for (const entry of match[1].split(",")) {
      for (const side of entry.split(/\s+as\s+/)) {
        // `export { type Foo }` — the inline modifier is not part of the name.
        const name = side.trim().replace(/^type\s+/, "").trim();
        if (IDENTIFIER.test(name)) names.add(name);
      }
    }
  }
  return names;
}

/**
 * Which of `names` the declaration file exports. Exact identifier comparison:
 * `getRequestStoreExtra` never satisfies a search for `getRequestStore`.
 *
 * @param {string} source contents of a `.d.ts` or `.d.cts` file
 * @param {readonly string[]} names identifiers to look for
 * @returns {string[]} the subset actually declared
 */
export function findDeclaredExports(source, names) {
  const declared = declaredExportNames(source);
  return names.filter((name) => declared.has(name));
}
