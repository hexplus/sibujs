import { describe, expect, it } from "vitest";
import { sibuVitePlugin } from "../src/build/vite";

describe("sibuVitePlugin static optimization", () => {
  it("should replace static tagFactory calls with staticTemplate in production", () => {
    const plugin = sibuVitePlugin({ staticOptimize: true, devMode: false });
    const result = plugin.transform?.('const el = div({ class: "card", nodes: "Hello" });', "src/app.ts");
    expect(result).not.toBeNull();
    expect(result?.code).toContain("staticTemplate");
    expect(result?.code).toContain('<div class=\\"card\\">Hello</div>');
  });

  it("should NOT transform reactive calls", () => {
    const plugin = sibuVitePlugin({ staticOptimize: true, devMode: false });
    const code = 'const el = div({ class: () => active(), nodes: "Hi" });';
    const result = plugin.transform?.(code, "src/app.ts");
    // Should either return null or not contain staticTemplate
    if (result) {
      expect(result.code).not.toContain("staticTemplate");
    }
  });

  it("should NOT run static optimization in dev mode by default", () => {
    const plugin = sibuVitePlugin({ devMode: true });
    const result = plugin.transform?.('const el = div({ class: "card", nodes: "Hello" });', "src/app.ts");
    // In dev mode, staticOptimize defaults to false
    if (result) {
      expect(result.code).not.toContain("staticTemplate");
    }
  });

  it("should add staticTemplate import when optimizing", () => {
    const plugin = sibuVitePlugin({ staticOptimize: true, devMode: false });
    const result = plugin.transform?.('const el = span({ nodes: "Text" });', "src/app.ts");
    expect(result).not.toBeNull();
    expect(result?.code).toContain("import { staticTemplate }");
  });

  it("should handle multiple static patterns", () => {
    const plugin = sibuVitePlugin({ staticOptimize: true, devMode: false });
    const code = `
      const a = h1({ nodes: "Title" });
      const b = p({ class: "body", nodes: "Content" });
    `;
    const result = plugin.transform?.(code, "src/app.ts");
    expect(result).not.toBeNull();
    // Both should be transformed
    const matches = result?.code.match(/staticTemplate/g);
    expect(matches?.length).toBeGreaterThanOrEqual(3); // import + 2 usages
  });

  it("should skip excluded files", () => {
    const plugin = sibuVitePlugin({ staticOptimize: true, devMode: false });
    const result = plugin.transform?.(
      'const el = div({ class: "card", nodes: "Hello" });',
      "node_modules/some-lib/index.ts",
    );
    expect(result).toBeNull();
  });

  it("should still inject pure annotations alongside static optimization", () => {
    const plugin = sibuVitePlugin({
      staticOptimize: true,
      pureAnnotations: true,
      devMode: false,
    });
    const code = 'const ctx = context("theme"); const el = div({ nodes: "Hi" });';
    const result = plugin.transform?.(code, "src/app.ts");
    expect(result).not.toBeNull();
    expect(result?.code).toContain("/*#__PURE__*/");
    expect(result?.code).toContain("staticTemplate");
  });
});
