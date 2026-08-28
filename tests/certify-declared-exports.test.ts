/**
 * The certification gate's internal-leak detector for generated declarations.
 *
 * WHAT WAS WRONG
 * --------------
 * The gate looked for a framework-internal symbol in `dist/*.d.ts` with
 *
 *     new RegExp(`\b${name}\b`)
 *
 * Inside a template literal `\b` is not the word-boundary assertion — it is the
 * BACKSPACE character (U+0008). The constructor received /\x08getRequestStore\x08/,
 * which matches nothing a TypeScript compiler will ever emit, so the check
 * returned false for every input and reported PASS unconditionally. A gate that
 * cannot fail is worse than no gate: it is a green light nobody re-examines.
 *
 * It also inspected only the text after the LAST `export {`, while tsup emits
 * `export { … } from './chunk.js'` blocks at the TOP of every declaration file.
 * A leak in one of those was outside the region being searched.
 *
 * WHAT THIS SUITE PINS
 * --------------------
 * The detector is now structural (`scripts/certify/lib/declared-exports.mjs`)
 * and is tested against a deliberately POSITIVE fixture, because the absence of
 * `getRequestStore()` from the current build proves nothing about a detector
 * that never matches. Every test below fails against the original `\b`
 * implementation, which is the point of writing them.
 *
 * The helper lives in its own module with no top-level side effects so that
 * importing it here does not run the audit — the audit resolves an installed
 * package from a consumer project's cwd and calls `process.exit`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { declaredExportNames, findDeclaredExports } from "../scripts/certify/lib/declared-exports.mjs";

const ROOT = resolve(__dirname, "..");

/** Internal to the framework: importable from `src/`, never from the package. */
const INTERNAL_ONLY = ["getRequestStore"] as const;

/**
 * Every declaration file a consumer can reach, taken from the package's own
 * `exports` map rather than from a hand-written list, so a new subpath is
 * covered the day it is added.
 */
function declarationTargets(): { subpath: string; file: string }[] {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    exports: Record<string, Record<string, string> | string>;
  };
  const targets: { subpath: string; file: string }[] = [];
  for (const [subpath, conditions] of Object.entries(pkg.exports)) {
    if (typeof conditions === "string") continue;
    for (const key of ["types", "import", "require"]) {
      const target = conditions[key];
      if (typeof target !== "string") continue;
      if (target.endsWith(".d.ts") || target.endsWith(".d.cts")) {
        targets.push({ subpath, file: target });
      }
    }
    // tsup emits a `.d.cts` beside every `.d.ts`; both are consumed, so both
    // are audited even though only one is named in the `types` condition.
    const types = conditions.types;
    if (types?.endsWith(".d.ts")) {
      targets.push({ subpath, file: types.replace(/\.d\.ts$/, ".d.cts") });
    }
  }
  return targets.filter((t, i) => targets.findIndex((o) => o.file === t.file) === i);
}

describe("the original implementation could not detect anything", () => {
  it("`\\b` in a template literal is a backspace, not a word boundary", () => {
    // Root cause, pinned so nobody reintroduces it believing it works.
    const broken = new RegExp(`\b${INTERNAL_ONLY[0]}\b`);
    expect(broken.source.charCodeAt(0), "expected the backspace character").toBe(0x08);
    expect(broken.test("export { getRequestStore };")).toBe(false);

    // The replacement answers the same question correctly.
    expect(findDeclaredExports("export { getRequestStore };", INTERNAL_ONLY)).toEqual(["getRequestStore"]);
  });

  it("the gate uses the shared detector rather than a private copy", () => {
    // Testing the helper is only meaningful if the gate actually calls it.
    const audit = readFileSync(resolve(ROOT, "scripts/certify/exports-audit.mjs"), "utf8");
    expect(audit).toContain('from "./lib/declared-exports.mjs"');
    expect(audit).toContain("findDeclaredExports(dts, INTERNAL_ONLY)");
  });
});

describe("positive detection", () => {
  it("1. finds a single-line export", () => {
    expect(findDeclaredExports("export { getRequestStore };", INTERNAL_ONLY)).toEqual(["getRequestStore"]);
  });

  it("2. finds it in a multiline export clause", () => {
    const source = ["export {", "  createStore,", "  getRequestStore,", "  isSSR,", "};", ""].join("\n");
    expect(findDeclaredExports(source, INTERNAL_ONLY)).toEqual(["getRequestStore"]);
  });

  it("finds it when separated by commas and newlines without spaces", () => {
    expect(findDeclaredExports("export{a,getRequestStore,b}", INTERNAL_ONLY)).toEqual(["getRequestStore"]);
    expect(findDeclaredExports("export {a\n,getRequestStore\n, b}", INTERNAL_ONLY)).toEqual(["getRequestStore"]);
  });

  it("finds it in a re-export block, which is where tsup puts chunk exports", () => {
    const source = "export { g as getRequestStore, S as SVG_NS } from './chunk-A1b2.js';";
    expect(findDeclaredExports(source, INTERNAL_ONLY)).toEqual(["getRequestStore"]);
  });

  it("finds it behind a rename in either direction", () => {
    // `getRequestStore as x` still publishes the internal's value; `x as
    // getRequestStore` publishes the internal's name. Both are leaks.
    expect(findDeclaredExports("export { getRequestStore as store };", INTERNAL_ONLY)).toEqual(["getRequestStore"]);
    expect(findDeclaredExports("export { store as getRequestStore };", INTERNAL_ONLY)).toEqual(["getRequestStore"]);
  });

  it("finds it in a `export type { … }` clause", () => {
    expect(findDeclaredExports("export type { getRequestStore };", INTERNAL_ONLY)).toEqual(["getRequestStore"]);
  });
});

describe("negative detection", () => {
  it("3. a declaration without the symbol is clean", () => {
    const source = "export { isSSR, runInSSRContext, withSSR };";
    expect(findDeclaredExports(source, INTERNAL_ONLY)).toEqual([]);
  });

  it("4. `getRequestStoreExtra` is not `getRequestStore`", () => {
    expect(findDeclaredExports("export { getRequestStoreExtra };", INTERNAL_ONLY)).toEqual([]);
    expect(findDeclaredExports("export { xgetRequestStore };", INTERNAL_ONLY)).toEqual([]);
    expect(findDeclaredExports("export { getRequestStore2 };", INTERNAL_ONLY)).toEqual([]);
  });

  it("5. a comment mentioning the symbol is not an export", () => {
    const lineComment = [
      "// export { getRequestStore }",
      "declare function isSSR(): boolean;",
      "export { isSSR };",
    ].join("\n");
    const blockComment = [
      "/**",
      " * Internal: getRequestStore() is not part of the public API.",
      " * export { getRequestStore }",
      " */",
      "export { isSSR };",
    ].join("\n");
    expect(findDeclaredExports(lineComment, INTERNAL_ONLY)).toEqual([]);
    expect(findDeclaredExports(blockComment, INTERNAL_ONLY)).toEqual([]);
  });

  it("a declared-but-not-exported symbol is not an export", () => {
    const source = [
      "declare function getRequestStore(): SSRStore | null;",
      "declare function isSSR(): boolean;",
      "export { isSSR };",
    ].join("\n");
    expect(findDeclaredExports(source, INTERNAL_ONLY)).toEqual([]);
  });

  it("a string literal type containing the text is not an export", () => {
    const source = 'type Docs = "export { getRequestStore }";\nexport { isSSR };';
    expect(findDeclaredExports(source, INTERNAL_ONLY)).toEqual([]);
  });
});

describe("the real built declarations", () => {
  const targets = declarationTargets();

  it("enumerates both .d.ts and .d.cts for every public subpath", () => {
    // 6. Guard: an empty list would make every assertion below vacuous.
    expect(targets.length).toBeGreaterThan(20);
    expect(targets.some((t) => t.file.endsWith(".d.ts"))).toBe(true);
    expect(targets.some((t) => t.file.endsWith(".d.cts"))).toBe(true);
  });

  it("7. the built package genuinely does not declare the internal", () => {
    const leaks: string[] = [];
    let inspected = 0;
    for (const { subpath, file } of targets) {
      const path = resolve(ROOT, file);
      expect(existsSync(path), `${file} is missing — run \`npm run build\``).toBe(true);
      inspected++;
      const found = findDeclaredExports(readFileSync(path, "utf8"), INTERNAL_ONLY);
      if (found.length > 0) leaks.push(`${subpath} (${file}) declares ${found.join(", ")}`);
    }
    expect(inspected).toBe(targets.length);
    expect(leaks).toEqual([]);
  });

  it("reads real export clauses out of every declaration file", () => {
    // A parser that returned nothing for some file would satisfy the check
    // above while inspecting nothing, so each file must yield real names.
    const empty: string[] = [];
    for (const { file } of targets) {
      const names = declaredExportNames(readFileSync(resolve(ROOT, file), "utf8"));
      if (names.size === 0) empty.push(file);
    }
    expect(empty, "the detector extracted no exports from these files").toEqual([]);
  });

  it("8. injecting the internal into a real declaration makes the detector fail it", () => {
    // Proving the negative above is only worth something if the same input with
    // the symbol added is rejected — this is the fixture the `\b` version
    // reported as clean.
    for (const file of ["dist/index.d.ts", "dist/index.d.cts"]) {
      const source = readFileSync(resolve(ROOT, file), "utf8");
      expect(findDeclaredExports(source, INTERNAL_ONLY), `${file} was not clean`).toEqual([]);

      // Into the final aggregate block…
      const atEnd = source.replace(/export \{ type Accessor,/, "export { getRequestStore, type Accessor,");
      expect(atEnd, `${file} lost its aggregate export block`).not.toBe(source);
      expect(findDeclaredExports(atEnd, INTERNAL_ONLY), `${file}: leak at end not caught`).toEqual(["getRequestStore"]);

      // …and into the first chunk re-export block, which the previous
      // `lastIndexOf("export {")` slice never looked at.
      const atStart = source.replace(/^export \{ /m, "export { getRequestStore, ");
      expect(atStart, `${file} lost its first re-export block`).not.toBe(source);
      expect(findDeclaredExports(atStart, INTERNAL_ONLY), `${file}: leak in the first block not caught`).toEqual([
        "getRequestStore",
      ]);
    }
  });

  it("still sees the public SSR surface, so it is reading real exports", () => {
    // A detector that found nothing anywhere would also pass test 7.
    const names = declaredExportNames(readFileSync(resolve(ROOT, "dist/index.d.ts"), "utf8"));
    for (const name of ["isSSR", "runInSSRContext", "withSSR", "getSSRStore", "signal"]) {
      expect(names.has(name), `${name} should be visible to the detector`).toBe(true);
    }
    expect(names.has("getRequestStore")).toBe(false);
  });
});
