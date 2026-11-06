import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { type Entrypoints, interopSuite } from "./entrypoint-interop.scenarios";

// ---------------------------------------------------------------------------
// The published CommonJS entry points, loaded the way a consumer's `require`
// loads them: `sibujs` → dist/index.cjs, `sibujs/plugins` → dist/plugins.cjs,
// resolved through the package's `exports`. They are bundled separately, so
// each carries its own copy of the rendering modules; nothing from source is
// loaded in this file. Needs a build (`npm run build`), as every dist suite.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

// A fresh page: no registry left by anything else in this worker.
for (const key of Object.getOwnPropertySymbols(globalThis)) {
  if (Symbol.keyFor(key)?.startsWith("sibujs.")) delete (globalThis as Record<symbol, unknown>)[key];
}

const load = async (): Promise<Entrypoints> => ({
  core: require("sibujs") as Entrypoints["core"],
  plugins: require("sibujs/plugins") as Entrypoints["plugins"],
});

describe("the premise", () => {
  it("each CommonJS entry point carries its own copy of the range and disposer modules", () => {
    const core = readFileSync(require.resolve("sibujs"), "utf8");
    const plugins = readFileSync(require.resolve("sibujs/plugins"), "utf8");
    expect(require.resolve("sibujs")).toMatch(/index\.cjs$/);
    expect(require.resolve("sibujs/plugins")).toMatch(/plugins\.cjs$/);
    for (const bundle of [core, plugins]) {
      expect(bundle).toContain("sibujs.ranges.v1");
      expect(bundle).toContain("sibujs.disposers.v1");
      expect(bundle).not.toMatch(/require\(["']\.\/chunk-/);
    }
  });
});

interopSuite("CommonJS entry points (dist/index.cjs + dist/plugins.cjs)", load);
