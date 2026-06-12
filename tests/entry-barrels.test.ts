import { describe, expect, it } from "vitest";

// These are the package's public entry points (see package.json "exports").
// Tests normally import from src/* directly, leaving the barrels uncovered.
// Importing each one here both covers the re-export modules and guards against
// a broken/renamed export silently disappearing from the public surface.
describe("entry barrels", () => {
  const barrels: [string, () => Promise<Record<string, unknown>>][] = [
    ["index", () => import("../index")],
    ["browser", () => import("../browser")],
    ["data", () => import("../data")],
    ["patterns", () => import("../patterns")],
    ["motion", () => import("../motion")],
    ["ui", () => import("../ui")],
    ["widgets", () => import("../widgets")],
    ["ssr", () => import("../ssr")],
    ["devtools", () => import("../devtools")],
    ["performance", () => import("../performance")],
    ["ecosystem", () => import("../ecosystem")],
    ["plugins", () => import("../plugins")],
    ["build", () => import("../build")],
    ["testing", () => import("../testing")],
    ["extras", () => import("../extras")],
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
