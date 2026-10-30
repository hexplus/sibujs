import { beforeAll, describe, expect, it } from "vitest";

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

  // Loaded once, up front: cold-importing the barrels transforms most of the
  // source tree, which under a parallel full-suite run exceeded the 15 s test
  // watchdog in whichever test happened to import first. Setup gets the long
  // watchdog the other cold-import suites use; each test still reports its own
  // barrel's load error.
  const loaded = new Map<string, Record<string, unknown> | Error>();
  beforeAll(async () => {
    for (const [name, load] of barrels) {
      loaded.set(name, await load().catch((err: unknown) => (err instanceof Error ? err : new Error(String(err)))));
    }
  }, 120_000);

  for (const [name] of barrels) {
    it(`"${name}" loads and re-exports a non-empty surface`, () => {
      const mod = loaded.get(name);
      if (mod instanceof Error) throw mod;
      expect(mod).toBeTypeOf("object");
      // Every barrel must surface at least one binding.
      expect(Object.keys(mod as Record<string, unknown>).length).toBeGreaterThan(0);
    });
  }
});
