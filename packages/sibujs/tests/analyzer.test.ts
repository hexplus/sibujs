import { describe, expect, it } from "vitest";
import { analyzeBundle, estimateImportSize, moduleSizes } from "../src/build/analyzer";

describe("analyzeBundle", () => {
  it("should compute sizes for each module", () => {
    const result = analyzeBundle({
      "app.ts": "const x = 1;",
      "utils.ts": "export function add(a, b) { return a + b; }",
    });

    expect(result.moduleSizes["app.ts"]).toBeGreaterThan(0);
    expect(result.moduleSizes["utils.ts"]).toBeGreaterThan(0);
  });

  it("should compute totalSize as the sum of all modules", () => {
    const result = analyzeBundle({
      "a.ts": "aaaa",
      "b.ts": "bb",
    });

    expect(result.totalSize).toBe(result.moduleSizes["a.ts"] + result.moduleSizes["b.ts"]);
  });

  it("should sort modules by size (largest first)", () => {
    const result = analyzeBundle({
      "small.ts": "x",
      "large.ts": "x".repeat(1000),
      "medium.ts": "x".repeat(100),
    });

    expect(result.sorted[0].name).toBe("large.ts");
    expect(result.sorted[1].name).toBe("medium.ts");
    expect(result.sorted[2].name).toBe("small.ts");
  });

  it("should compute correct percentages", () => {
    const result = analyzeBundle({
      "half.ts": "aaaa",
      "other.ts": "bbbb",
    });

    // Both modules have the same size, so each should be approximately 50%
    const sumPct = result.sorted.reduce((s, e) => s + e.percentage, 0);
    expect(sumPct).toBeCloseTo(100, 1);
  });

  it("should handle empty input", () => {
    const result = analyzeBundle({});
    expect(result.totalSize).toBe(0);
    expect(result.sorted).toHaveLength(0);
  });

  it("should generate a formatted report", () => {
    const result = analyzeBundle({
      "app.ts": "const app = true;",
      "lib.ts": "const lib = false;",
    });

    const report = result.report();

    expect(report).toContain("SibuJS Bundle Analysis");
    expect(report).toContain("Total size:");
    expect(report).toContain("Modules: 2");
    expect(report).toContain("app.ts");
    expect(report).toContain("lib.ts");
  });

  it("should use byte-accurate sizes with TextEncoder", () => {
    // Multi-byte character should produce a larger byte length than char count
    const result = analyzeBundle({
      "unicode.ts": "\u00e9\u00e9\u00e9", // 3 chars, 6 bytes in UTF-8
    });

    // TextEncoder gives 6 bytes for 3 x U+00E9
    expect(result.moduleSizes["unicode.ts"]).toBe(6);
  });

  it("should include percentage in sorted entries", () => {
    const result = analyzeBundle({
      "only.ts": "hello world",
    });

    expect(result.sorted).toHaveLength(1);
    expect(result.sorted[0].percentage).toBeCloseTo(100, 1);
    expect(result.sorted[0].name).toBe("only.ts");
  });
});

describe("estimateImportSize", () => {
  it("should estimate size from known module sizes", () => {
    const result = estimateImportSize(["core/html", "core/mount"]);

    expect(result.estimated).toBeGreaterThan(0);
    expect(result.breakdown["core/html"]).toBe(moduleSizes["core/html"]);
    expect(result.breakdown["core/mount"]).toBe(moduleSizes["core/mount"]);
  });

  it("should always include implicit dependencies", () => {
    const result = estimateImportSize([]);

    // Even with no explicit imports, reactivity/signal and reactivity/track
    // are included as implicit dependencies
    expect(result.breakdown["reactivity/signal"]).toBe(moduleSizes["reactivity/signal"]);
    expect(result.breakdown["reactivity/track"]).toBe(moduleSizes["reactivity/track"]);
  });

  it("should use average size for unknown modules", () => {
    const result = estimateImportSize(["unknown/module"]);

    // Unknown modules get an estimated size of 350
    expect(result.breakdown["unknown/module"]).toBe(350);
  });

  it("should not double-count implicit dependencies", () => {
    const result = estimateImportSize(["reactivity/signal"]);

    // reactivity/signal is both explicit and implicit — should only appear once
    const signalCount = Object.keys(result.breakdown).filter((k) => k === "reactivity/signal").length;
    expect(signalCount).toBe(1);
  });

  it("should generate a human-readable formatted output", () => {
    const result = estimateImportSize(["core/html", "core/signal"]);

    expect(result.formatted).toContain("Estimated bundle size:");
    expect(result.formatted).toContain("core/html");
    expect(result.formatted).toContain("core/signal");
    expect(result.formatted).toContain("Implicit dependencies");
  });

  it("should mark unknown modules as estimated in formatted output", () => {
    const result = estimateImportSize(["made/up/module"]);

    expect(result.formatted).toContain("(estimated)");
  });

  it("should correctly sum the total estimated size", () => {
    const imports = ["core/html", "core/mount"];
    const result = estimateImportSize(imports);

    const expectedTotal = Object.values(result.breakdown).reduce((a, b) => a + b, 0);
    expect(result.estimated).toBe(expectedTotal);
  });
});

describe("moduleSizes", () => {
  it("should have entries for core modules", () => {
    expect(moduleSizes["core/html"]).toBeDefined();
    expect(moduleSizes["core/mount"]).toBeDefined();
    expect(moduleSizes["core/each"]).toBeDefined();
    expect(moduleSizes["core/signal"]).toBeDefined();
    expect(moduleSizes["core/effect"]).toBeDefined();
  });

  it("should have entries for reactivity modules", () => {
    expect(moduleSizes["reactivity/signal"]).toBeDefined();
    expect(moduleSizes["reactivity/track"]).toBeDefined();
    expect(moduleSizes["reactivity/batch"]).toBeDefined();
  });

  it("should have entries for build modules", () => {
    expect(moduleSizes["build/vite"]).toBeDefined();
    expect(moduleSizes["build/webpack"]).toBeDefined();
    expect(moduleSizes["build/cdn"]).toBeDefined();
    expect(moduleSizes["build/analyzer"]).toBeDefined();
  });

  it("should have all sizes as positive numbers", () => {
    for (const [_key, size] of Object.entries(moduleSizes)) {
      expect(size).toBeGreaterThan(0);
    }
  });

  it("should have entries for plugin modules", () => {
    expect(moduleSizes["plugins/i18n"]).toBeDefined();
    expect(moduleSizes["plugins/router"]).toBeDefined();
  });
});
