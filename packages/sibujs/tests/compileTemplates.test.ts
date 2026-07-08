import { describe, expect, it } from "vitest";
import { compileHtmlTemplates } from "../src/build/compileTemplates";

describe("compileHtmlTemplates", () => {
  it("should return null code when no templates found", () => {
    const result = compileHtmlTemplates('const x = div({ class: "foo" })');
    expect(result.code).toBeNull();
    expect(result.compiledCount).toBe(0);
  });

  it("should compile a simple static template", () => {
    const code = 'const el = html`<div class="hello">world</div>`;';
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.compiledCount).toBe(1);
    expect(result.usedTags.has("div")).toBe(true);
    // Should produce a div() call, not html``
    expect(result.code).toContain("div(");
    expect(result.code).not.toContain("html`");
  });

  it("should compile template with expression attributes", () => {
    const code = "const el = html`<div class=${cls}>text</div>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain("div(");
    expect(result.code).toContain("cls");
    expect(result.code).not.toContain("html`");
  });

  it("should compile template with expression children", () => {
    const code = "const el = html`<span>${() => count()}</span>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain("span(");
    expect(result.code).toContain("() => count()");
  });

  it("should compile nested elements", () => {
    const code = "const el = html`<div><span>inner</span></div>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.usedTags.has("div")).toBe(true);
    expect(result.usedTags.has("span")).toBe(true);
    expect(result.code).toContain("div(");
    expect(result.code).toContain("span(");
  });

  it("should compile event handlers", () => {
    const code = "const el = html`<button on:click=${handler}>Click</button>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain("button(");
    expect(result.code).toContain("on:");
    expect(result.code).toContain("handler");
  });

  it("should handle void elements", () => {
    const code = 'const el = html`<input type="text" />`;';
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.usedTags.has("input")).toBe(true);
  });

  it("should detect SVG tags", () => {
    const code = 'const el = html`<svg><circle r="10" /></svg>`;';
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.usesSvg).toBe(true);
  });

  it("should compile multiple templates in same file", () => {
    const code = ["const a = html`<div>first</div>`;", "const b = html`<span>second</span>`;"].join("\n");
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.compiledCount).toBe(2);
    expect(result.code).not.toContain("html`");
  });

  it("should handle mixed static and expression attributes", () => {
    const code = 'const el = html`<div class="base ${extra}">text</div>`;';
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain("div(");
    expect(result.code).toContain("extra");
  });

  it("should handle boolean attributes", () => {
    const code = "const el = html`<input disabled />`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain("true");
  });
});
