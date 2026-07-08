import { describe, expect, it } from "vitest";

// These are the package's public entry points (see package.json "exports").
// Tests normally import from src/* directly, leaving the barrels uncovered.
// Importing each one here both covers the re-export modules and guards against
// a broken/renamed export silently disappearing from the public surface.
describe("entry barrels", () => {
  const barrels: [string, () => Promise<Record<string, unknown>>][] = [
    // Std tier only — long-tail barrels (browser, widgets, patterns, motion,
    // devtools, performance, ecosystem, extras) moved to @sibujs/labs.
    ["index", () => import("../index")],
    ["data", () => import("../data")],
    ["ui", () => import("../ui")],
    ["ssr", () => import("../ssr")],
    ["plugins", () => import("../plugins")],
    ["build", () => import("../build")],
    ["testing", () => import("../testing")],
    ["cdn", () => import("../cdn")],
  ];

  for (const [name, load] of barrels) {
    it(`"${name}" loads and re-exports a non-empty surface`, async () => {
      const mod = await load();
      expect(mod).toBeTypeOf("object");
      // Every barrel must surface at least one binding.
      expect(Object.keys(mod).length).toBeGreaterThan(0);
    });
  }
});
