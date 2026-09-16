// @vitest-environment node
//
// Internal render-transaction and id helpers must not become public API through
// the root barrel: an unpaired `endDisposerCapture()` would corrupt an open
// transaction, and `idSegment` is a widget-internal detail. Asserted against the
// BUILT package (runtime + declarations + CDN), because that is what consumers
// import.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const requireFn = createRequire(import.meta.url);

const INTERNAL_NAMES = [
  "idSegment",
  "withDisposerRollback",
  "currentDisposerCapture",
  "beginDisposerCapture",
  "endDisposerCapture",
];
const PUBLIC_NAMES = [
  "createId",
  "__resetIdCounter",
  "dispose",
  "registerDisposer",
  "unregisterDisposer",
  "replaceChildrenSafely",
  "checkLeaks",
  "MAX_DRAIN_TEARDOWNS",
  "reportDrainRunaway",
];

const artifacts = {
  esm: resolve(ROOT, "dist/index.js"),
  cjs: resolve(ROOT, "dist/index.cjs"),
  esmTypes: resolve(ROOT, "dist/index.d.ts"),
  cjsTypes: resolve(ROOT, "dist/index.d.cts"),
  cdn: resolve(ROOT, "dist/cdn.global.js"),
};
const built = Object.values(artifacts).every((file) => existsSync(file));
const onCI = !!process.env.CI;

describe.skipIf(!built && !onCI)("root barrel keeps internals internal", () => {
  it("the ESM and CJS runtimes export the public names and none of the internal ones", async () => {
    const esm = (await import(/* @vite-ignore */ artifacts.esm)) as Record<string, unknown>;
    const cjs = requireFn(artifacts.cjs) as Record<string, unknown>;
    for (const surface of [esm, cjs]) {
      for (const name of PUBLIC_NAMES) expect(surface[name], `${name} must stay public`).toBeDefined();
      for (const name of INTERNAL_NAMES) expect(surface[name], `${name} must not be public`).toBeUndefined();
    }
  });

  it("the declarations do not name the internal helpers", () => {
    for (const file of [artifacts.esmTypes, artifacts.cjsTypes]) {
      const source = readFileSync(file, "utf8");
      for (const name of PUBLIC_NAMES) expect(source, `${name} missing from ${file}`).toContain(name);
      for (const name of INTERNAL_NAMES) {
        expect(new RegExp(`\\b${name}\\b`).test(source), `${name} leaked into ${file}`).toBe(false);
      }
    }
  });

  it("the CDN global exposes the public helpers only", () => {
    const source = readFileSync(artifacts.cdn, "utf8");
    // Minified code keeps only the exported NAMES in the global assignment.
    for (const name of INTERNAL_NAMES) {
      expect(new RegExp(`\\b${name}\\b`).test(source), `${name} leaked into the CDN bundle`).toBe(false);
    }
    expect(source).toContain("replaceChildrenSafely");
  });
});
