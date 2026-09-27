import { describe, expect, it } from "vitest";
import { sibuVitePlugin } from "../src/build/vite";
import { runModule } from "./helpers/buildTransformHarness";

const IMPORT = 'import { div, span, h1, p, context } from "sibujs";\n';

describe("sibuVitePlugin static optimization", () => {
  it("is off by default, in production too", () => {
    const plugin = sibuVitePlugin({ devMode: false, pureAnnotations: false });
    const result = plugin.transform?.(`${IMPORT}const el = div({ class: "card", nodes: "Hello" });`, "src/app.ts");
    expect(result).toBeNull();
  });

  it("should replace static tag-factory calls with staticTemplate when enabled", () => {
    const plugin = sibuVitePlugin({ staticOptimize: true, devMode: false });
    const result = plugin.transform?.(`${IMPORT}const el = div({ class: "card", nodes: "Hello" });`, "src/app.ts");
    expect(result).not.toBeNull();
    expect(result?.code).toContain("staticTemplate");
    expect(result?.code).toContain('<div class=\\"card\\">Hello</div>');
  });

  it("should NOT transform reactive calls", () => {
    const plugin = sibuVitePlugin({ staticOptimize: true, devMode: false });
    const code = `${IMPORT}const el = div({ class: () => active(), nodes: "Hi" });`;
    const result = plugin.transform?.(code, "src/app.ts");
    expect(result?.code ?? code).not.toContain("staticTemplate");
  });

  it("should NOT run static optimization in dev mode by default", () => {
    const plugin = sibuVitePlugin({ devMode: true });
    const result = plugin.transform?.(`${IMPORT}const el = div({ class: "card", nodes: "Hello" });`, "src/app.ts");
    expect(result?.code ?? "").not.toContain("staticTemplate");
  });

  it("should import staticTemplate from sibujs/performance under an alias", () => {
    const plugin = sibuVitePlugin({ staticOptimize: true, devMode: false });
    const result = plugin.transform?.(`${IMPORT}const el = span({ nodes: "Text" });`, "src/app.ts");
    expect(result?.code).toContain('import { staticTemplate as __sibujs$staticTemplate } from "sibujs/performance";');
  });

  it("should handle multiple static patterns", () => {
    const plugin = sibuVitePlugin({ staticOptimize: true, devMode: false });
    const code = `${IMPORT}
      const a = h1({ nodes: "Title" });
      const b = p({ class: "body", nodes: "Content" });
    `;
    const result = plugin.transform?.(code, "src/app.ts");
    expect(result?.code.match(/__sibujs\$static\("/g)?.length).toBe(2);
  });

  it("should skip excluded files", () => {
    const plugin = sibuVitePlugin({ staticOptimize: true, devMode: false });
    const result = plugin.transform?.(
      `${IMPORT}const el = div({ class: "card", nodes: "Hello" });`,
      "node_modules/some-lib/index.ts",
    );
    expect(result).toBeNull();
  });

  it("should still inject pure annotations alongside static optimization", () => {
    const plugin = sibuVitePlugin({ staticOptimize: true, pureAnnotations: true, devMode: false });
    const code = `${IMPORT}const ctx = context("theme"); const el = div({ nodes: "Hi" });`;
    const result = plugin.transform?.(code, "src/app.ts");
    expect(result?.code).toContain("/*#__PURE__*/ context(");
    expect(result?.code).toContain("__sibujs$static(");
  });

  it("produces an element identical to the tag factory's", () => {
    const plugin = sibuVitePlugin({ staticOptimize: true, devMode: false, pureAnnotations: false });
    const src = `${IMPORT}export default () => div({ class: "card", id: "c", title: "t" }, "Hello & bye");`;
    const out = plugin.transform?.(src, "src/app.js")?.code as string;
    const optimized = runModule<() => Element>(out)();
    const factory = runModule<() => Element>(src)();
    expect(optimized.outerHTML).toBe(factory.outerHTML);
    expect(optimized.parentNode).toBeNull();
    expect(optimized.ownerDocument).toBe(document);
  });
});
