import { describe, expect, it } from "vitest";

// @sibujs/labs public entry points (see package.json "exports"). Importing each
// barrel covers the re-export modules and guards against a broken/renamed export
// silently disappearing from the labs surface.
describe("labs entry barrels", () => {
  const barrels: [string, () => Promise<Record<string, unknown>>][] = [
    ["index", () => import("../index")],
    ["browser", () => import("../browser")],
    ["widgets", () => import("../widgets")],
    ["patterns", () => import("../patterns")],
    ["ecosystem", () => import("../ecosystem")],
    ["performance", () => import("../performance")],
    ["devtools", () => import("../devtools")],
    ["motion", () => import("../motion")],
  ];

  for (const [name, load] of barrels) {
    it(`"${name}" loads and re-exports a non-empty surface`, async () => {
      const mod = await load();
      expect(mod).toBeTypeOf("object");
      expect(Object.keys(mod).length).toBeGreaterThan(0);
    });
  }
});
