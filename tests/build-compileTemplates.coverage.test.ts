import { describe, expect, it } from "vitest";
import { compileHtmlTemplates } from "../src/build/compileTemplates";

describe("compileHtmlTemplates - coverage edge cases", () => {
  it("compiles a template with multiple expressions, wrapping in an IIFE", () => {
    const code = "const el = html`<div class=${cls} id=${theId}>${child}</div>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    // IIFE wrapper with the value array
    expect(result.code).toContain("(__v) =>");
    expect(result.code).toContain("cls");
    expect(result.code).toContain("theId");
    expect(result.code).toContain("child");
  });

  it("preserves complex original expression source via extractExpressions", () => {
    const code = "const el = html`<div class=${a ? `x ${y}` : 'z'}>${items.map(i => i)}</div>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain("a ? `x ${y}` : 'z'");
    expect(result.code).toContain("items.map(i => i)");
  });

  it("handles mixed text and expression children with whitespace collapsing", () => {
    const code = "const el = html`<p>Hello   ${name}   world</p>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    // Collapsed leading/trailing text segments around the expr
    expect(result.code).toContain('"Hello "');
    expect(result.code).toContain('" world"');
  });

  it("emits an svg element with props through __sbTagFactory", () => {
    const code = "const el = html`<svg width=${w}><circle r=${r} /></svg>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.usesSvg).toBe(true);
    expect(result.code).toContain('__sbTagFactory("svg", __sbSVG_NS)');
    expect(result.code).toContain('__sbTagFactory("circle", __sbSVG_NS)');
  });

  it("emits an svg element without props as __sbTagFactory(...)({})", () => {
    const code = "const el = html`<svg></svg>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain('__sbTagFactory("svg", __sbSVG_NS)({})');
  });

  it("emits a non-svg element without props as tag({})", () => {
    const code = "const el = html`<br>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain("br({})");
  });

  it("handles multiple children producing a nodes array", () => {
    const code = "const el = html`<div><span>a</span><span>b</span></div>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain("nodes: [");
  });

  it("handles a single child producing a non-array nodes value", () => {
    const code = "const el = html`<div><span>only</span></div>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).toMatch(/nodes: span\(/);
  });

  it("handles escape sequences inside the template literal", () => {
    const code = 'const el = html`<div title="a\\`b">x</div>`;';
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).not.toContain("html`");
  });

  it("returns null code for an unterminated template literal", () => {
    const code = "const el = html`<div>unterminated";
    const result = compileHtmlTemplates(code);
    // findHtmlTemplates skips templates it cannot parse -> no templates -> null
    expect(result.code).toBeNull();
    expect(result.compiledCount).toBe(0);
  });

  it("handles a mixed-value attribute (static + expr concatenation)", () => {
    const code = 'const el = html`<div class="base ${extra} end">x</div>`;';
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain("String(");
    expect(result.code).toContain('"base "');
  });

  it("handles unquoted attribute values", () => {
    const code = "const el = html`<input type=text>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain('"type": "text"');
  });

  it("handles an expression attribute value", () => {
    const code = "const el = html`<a href=${url}>link</a>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain("__v[0]");
  });

  it("handles nested expressions inside attribute object literals", () => {
    const code = "const el = html`<div data-x=${ { a: 1, b: { c: 2 } } }>x</div>`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.code).toContain("{ a: 1, b: { c: 2 } }");
  });

  it("handles a self-closing non-void element", () => {
    const code = "const el = html`<div class=${c} />`;";
    const result = compileHtmlTemplates(code);
    expect(result.code).not.toBeNull();
    expect(result.usedTags.has("div")).toBe(true);
  });

  it("counts templates compiled across the file", () => {
    const code = [
      "const a = html`<div>${x}</div>`;",
      "const b = html`<span class=${c}>${y}</span>`;",
      "const c = html`<p>plain</p>`;",
    ].join("\n");
    const result = compileHtmlTemplates(code);
    expect(result.compiledCount).toBe(3);
    expect(result.code).not.toContain("html`");
  });

  it("ignores 'html' identifiers that are not tagged templates", () => {
    const code = "const html = 5; const x = htmlFoo`<div></div>`;";
    const result = compileHtmlTemplates(code);
    // htmlFoo has a word boundary mismatch on \bhtml followed by backtick check;
    // there is no `html\`` so nothing compiles.
    expect(result.code).toBeNull();
  });
});
