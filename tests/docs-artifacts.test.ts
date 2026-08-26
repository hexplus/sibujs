import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Documentation / packaging consistency.
//
// THE INVARIANT UNDER TEST: every distribution file the documentation tells a
// user to load, and every path the exports map promises, actually exists in
// `dist/`.
//
// Regression origin: the README's CDN snippet pointed at
// `dist/sibu.global.js`, but the build emits `dist/cdn.global.js`. Copy-pasting
// the documented snippet produced a 404. Nothing checked the two against each
// other, so the drift survived every green CI run.
//
// This test is deliberately written as a SCAN rather than a hard-coded list, so
// a future doc that names a non-existent artifact fails here too.
//
// Requires `npm run build` first — same precondition as consumption.test.ts.
// ---------------------------------------------------------------------------

const root = resolve(__dirname, "..");
const distDir = resolve(root, "dist");

function markdownFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) markdownFiles(full, acc);
    else if (entry.endsWith(".md")) acc.push(full);
  }
  return acc;
}

/** `dist/<file>` references, forward-slash only so Windows error transcripts
 *  quoted inside hardening notes are not mistaken for real references. */
const DIST_REFERENCE = /dist\/([A-Za-z0-9._-]+\.(?:js|cjs|mjs))/g;

describe("documented dist artifacts exist", () => {
  const docs = [resolve(root, "README.md"), ...markdownFiles(resolve(root, "docs"))];

  it("finds documentation to scan", () => {
    expect(docs.length).toBeGreaterThan(1);
  });

  for (const doc of docs) {
    const relative = doc.slice(root.length + 1).replace(/\\/g, "/");
    const source = readFileSync(doc, "utf-8");
    const referenced = new Set<string>();
    for (const match of source.matchAll(DIST_REFERENCE)) referenced.add(match[1]);
    if (referenced.size === 0) continue;

    it(`${relative} references only artifacts the build emits`, () => {
      const missing = [...referenced].filter((file) => !existsSync(resolve(distDir, file)));
      expect(missing).toEqual([]);
    });
  }
});

describe("package.json exports resolve to real files", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8")) as {
    main: string;
    module: string;
    types: string;
    exports: Record<string, Record<string, string> | string>;
  };

  it("main, module and types exist", () => {
    for (const field of [pkg.main, pkg.module, pkg.types]) {
      expect(existsSync(resolve(root, field)), `${field} is missing`).toBe(true);
    }
  });

  const targets: [string, string][] = [];
  for (const [subpath, value] of Object.entries(pkg.exports)) {
    if (typeof value === "string") targets.push([subpath, value]);
    else for (const [condition, target] of Object.entries(value)) targets.push([`${subpath} (${condition})`, target]);
  }

  it("declares at least the documented subpaths", () => {
    expect(targets.length).toBeGreaterThan(10);
  });

  for (const [label, target] of targets) {
    it(`exports "${label}" -> ${target} exists`, () => {
      expect(existsSync(resolve(root, target))).toBe(true);
    });
  }
});

describe("CDN global bundle", () => {
  const cdnTarget = "dist/cdn.global.js";

  it("is emitted by the build", () => {
    expect(existsSync(resolve(root, cdnTarget))).toBe(true);
  });

  it("is a self-contained IIFE exposing the documented global name", () => {
    const source = readFileSync(resolve(root, cdnTarget), "utf-8");
    expect(source.length).toBeGreaterThan(1000);
    // The build declares `--globalName Sibu`; the README tells users to read
    // `window.Sibu`. Keep those two facts tied together.
    expect(source).toContain("Sibu");
    // A CDN bundle that still contains bare import statements would fail in a
    // plain <script> tag.
    expect(source).not.toMatch(/^\s*import\s+.*\s+from\s+["']/m);
  });

  it("is the artifact the README's CDN snippet points at", () => {
    const readme = readFileSync(resolve(root, "README.md"), "utf-8");
    const scriptTags = [...readme.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    const cdnTags = scriptTags.filter((src) => src.includes("sibujs") && src.includes("dist/"));
    expect(cdnTags.length).toBeGreaterThan(0);
    for (const tag of cdnTags) {
      const file = tag.slice(tag.indexOf("dist/"));
      expect(existsSync(resolve(root, file)), `README references ${file}, which the build does not emit`).toBe(true);
    }
  });
});
