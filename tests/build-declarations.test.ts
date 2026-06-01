import { describe, expect, it } from "vitest";
import { generateTsConfig, validateTsConfig } from "../src/build/declarations";

describe("generateTsConfig", () => {
  it("returns sensible defaults", () => {
    const config = generateTsConfig();
    const co = config.compilerOptions as Record<string, unknown>;
    expect(co.target).toBe("ES2020");
    expect(co.outDir).toBe("dist");
    expect(co.declarationMap).toBe(true);
    expect(co.strict).toBe(true);
    expect(config.include).toEqual(["src/**/*.ts", "src/**/*.tsx"]);
    expect(config.exclude).toContain("node_modules");
  });

  it("honors custom target, outDir, and declarationMap", () => {
    const config = generateTsConfig({ target: "ES2022", outDir: "build", declarationMap: false });
    const co = config.compilerOptions as Record<string, unknown>;
    expect(co.target).toBe("ES2022");
    expect(co.outDir).toBe("build");
    expect(co.declarationMap).toBe(false);
  });

  it("adds path aliases including default sibu aliases when paths are provided", () => {
    const config = generateTsConfig({ paths: { "@app/*": ["src/*"] } });
    const co = config.compilerOptions as Record<string, unknown>;
    expect(co.baseUrl).toBe(".");
    const paths = co.paths as Record<string, string[]>;
    expect(paths.sibu).toEqual(["node_modules/sibu/dist/index.d.ts"]);
    expect(paths["sibu/*"]).toEqual(["node_modules/sibu/dist/*"]);
    expect(paths["@app/*"]).toEqual(["src/*"]);
  });

  it("does not add baseUrl/paths when paths object is empty", () => {
    const config = generateTsConfig({ paths: {} });
    const co = config.compilerOptions as Record<string, unknown>;
    expect(co.baseUrl).toBeUndefined();
    expect(co.paths).toBeUndefined();
  });
});

describe("validateTsConfig", () => {
  it("a fully recommended config is valid with no warnings", () => {
    const config = generateTsConfig();
    const result = validateTsConfig(config);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("warns about missing required options", () => {
    const result = validateTsConfig({ compilerOptions: {} });
    expect(result.valid).toBe(false);
    // strict and esModuleInterop are exact-value required; moduleResolution is array required
    expect(result.warnings.some((w) => w.includes("strict"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("esModuleInterop"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("moduleResolution"))).toBe(true);
  });

  it("warns when a required exact-value option has the wrong value", () => {
    const result = validateTsConfig({
      compilerOptions: { strict: false, esModuleInterop: true, moduleResolution: "bundler" },
    });
    expect(result.warnings.some((w) => w.includes('"strict"') && w.includes("recommends"))).toBe(true);
  });

  it("warns when a required array-value option has an unsupported value", () => {
    const result = validateTsConfig({
      compilerOptions: { strict: true, esModuleInterop: true, moduleResolution: "classic" },
    });
    expect(result.warnings.some((w) => w.includes("moduleResolution") && w.includes("classic"))).toBe(true);
  });

  it("accepts any of the allowed array values for moduleResolution", () => {
    for (const mr of ["node", "bundler", "node16", "nodenext"]) {
      const result = validateTsConfig({
        compilerOptions: { strict: true, esModuleInterop: true, moduleResolution: mr },
      });
      expect(result.warnings.some((w) => w.includes("moduleResolution"))).toBe(false);
    }
  });

  it("suggests improvements for suggested options that are missing", () => {
    const result = validateTsConfig({
      compilerOptions: { strict: true, esModuleInterop: true, moduleResolution: "bundler" },
    });
    expect(result.suggestions.some((s) => s.includes("declarationMap"))).toBe(true);
    expect(result.suggestions.some((s) => s.includes("noUncheckedIndexedAccess"))).toBe(true);
  });

  it("warns about an outdated compilation target", () => {
    const result = validateTsConfig({
      compilerOptions: { strict: true, esModuleInterop: true, moduleResolution: "bundler", target: "es5" },
    });
    expect(result.warnings.some((w) => w.includes("Target") && w.includes("ES5"))).toBe(true);
  });

  it("accepts ESNext target without target warning", () => {
    const result = validateTsConfig({
      compilerOptions: { strict: true, esModuleInterop: true, moduleResolution: "bundler", target: "esnext" },
    });
    expect(result.warnings.some((w) => w.startsWith("Target"))).toBe(false);
  });

  it("suggests a better module system when an unusual one is set", () => {
    const result = validateTsConfig({
      compilerOptions: { strict: true, esModuleInterop: true, moduleResolution: "bundler", module: "commonjs" },
    });
    expect(result.suggestions.some((s) => s.includes("Module") && s.includes("commonjs"))).toBe(true);
  });

  it("suggests adding DOM to lib when it is missing", () => {
    const result = validateTsConfig({
      compilerOptions: { strict: true, esModuleInterop: true, moduleResolution: "bundler", lib: ["ES2020"] },
    });
    expect(result.suggestions.some((s) => s.includes("DOM"))).toBe(true);
  });

  it("does not suggest DOM when lib already contains it", () => {
    const result = validateTsConfig({
      compilerOptions: {
        strict: true,
        esModuleInterop: true,
        moduleResolution: "bundler",
        lib: ["ES2020", "DOM", "DOM.Iterable"],
      },
    });
    expect(result.suggestions.some((s) => s.includes('does not include "DOM"'))).toBe(false);
  });

  it("suggests fixing include patterns that miss TypeScript files", () => {
    const result = validateTsConfig({
      compilerOptions: { strict: true, esModuleInterop: true, moduleResolution: "bundler" },
      include: ["assets/styles.css"],
    });
    expect(result.suggestions.some((s) => s.includes("include"))).toBe(true);
  });

  it("does not flag include patterns that capture TypeScript files", () => {
    const result = validateTsConfig({
      compilerOptions: { strict: true, esModuleInterop: true, moduleResolution: "bundler" },
      include: ["src/**/*.ts"],
    });
    expect(result.suggestions.some((s) => s.includes('"include" patterns may not capture'))).toBe(false);
  });

  it("treats a config without compilerOptions as missing all required options", () => {
    const result = validateTsConfig({});
    expect(result.valid).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
