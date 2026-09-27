import { describe, expect, it } from "vitest";
import { analyzeStaticTemplates } from "../src/build/staticAnalysis";

const IMPORT = 'import { div, span, p, h1, br, input, button, a, label } from "sibujs";\n';

function analyze(code: string) {
  return analyzeStaticTemplates(`${IMPORT}${code}`);
}

describe("analyzeStaticTemplates", () => {
  it("should detect a fully static div call", () => {
    const result = analyze('div({ class: "card", nodes: "Hello" })');
    expect(result.hasStaticPatterns).toBe(true);
    expect(result.patterns.length).toBe(1);
    expect(result.patterns[0].tag).toBe("div");
    expect(result.patterns[0].templateHtml).toBe('<div class="card">Hello</div>');
  });

  it("should detect positional children and the class/text shorthand", () => {
    expect(analyze('div({ id: "x" }, "Hi")').patterns[0].templateHtml).toBe('<div id="x">Hi</div>');
    expect(analyze('span("text")').patterns[0].templateHtml).toBe("<span>text</span>");
    expect(analyze('span("cls", "text")').patterns[0].templateHtml).toBe('<span class="cls">text</span>');
  });

  it("should NOT detect calls with arrow function props", () => {
    const result = analyze('div({ class: () => activeClass(), nodes: "Hello" })');
    expect(result.hasStaticPatterns).toBe(false);
  });

  it("should NOT detect calls with event handlers", () => {
    const result = analyze('button({ on: { click: handleClick }, nodes: "Click" })');
    expect(result.hasStaticPatterns).toBe(false);
  });

  it("should NOT detect calls with ref", () => {
    const result = analyze('div({ ref: myRef, nodes: "Content" })');
    expect(result.hasStaticPatterns).toBe(false);
  });

  it("should detect multiple static patterns", () => {
    const result = analyze(`
      const header = h1({ nodes: "Title" });
      const body = p({ class: "text", nodes: "Content" });
    `);
    expect(result.patterns.length).toBe(2);
  });

  it("should handle void elements", () => {
    const result = analyze("br({})");
    expect(result.hasStaticPatterns).toBe(true);
    expect(result.patterns[0].templateHtml).toBe("<br />");
  });

  it("should render booleans and numbers the way the tag factory does", () => {
    const result = analyze('input({ disabled: true, tabindex: 0, hidden: false, title: null, "aria-checked": false })');
    expect(result.patterns[0].templateHtml).toBe('<input disabled="" tabindex="0" aria-checked="false" />');
  });

  it("should NOT detect calls with variable references as values", () => {
    const result = analyze('div({ class: className, nodes: "Hello" })');
    expect(result.hasStaticPatterns).toBe(false);
  });

  it("should NOT detect calls with function keyword props", () => {
    const result = analyze('div({ class: function() { return "x"; } })');
    expect(result.hasStaticPatterns).toBe(false);
  });

  it("should handle id attribute", () => {
    const result = analyze('div({ id: "main", nodes: "Hello" })');
    expect(result.patterns[0].templateHtml).toBe('<div id="main">Hello</div>');
  });

  it("should emit class and id first, like the tag factory", () => {
    const result = analyze('div({ title: "t", id: "i", class: "c" })');
    expect(result.patterns[0].templateHtml).toBe('<div class="c" id="i" title="t"></div>');
  });

  it("should return correct start and end positions", () => {
    const prefix = `${IMPORT}const el = `;
    const call = 'span({ nodes: "X" })';
    const result = analyzeStaticTemplates(prefix + call);
    expect(result.patterns[0].start).toBe(prefix.length);
    expect(result.patterns[0].end).toBe(prefix.length + call.length);
    expect(result.patterns[0].original).toBe(call);
  });

  it("should NOT detect non-HTML tag names", () => {
    const result = analyze('myComponent({ class: "x", nodes: "Y" })');
    expect(result.hasStaticPatterns).toBe(false);
  });

  it("should NOT detect tag calls that are not imported from sibujs", () => {
    expect(analyzeStaticTemplates('div({ class: "card" })').hasStaticPatterns).toBe(false);
    expect(analyzeStaticTemplates('import { div } from "other";\ndiv({ class: "card" })').hasStaticPatterns).toBe(
      false,
    );
  });

  it("should return empty patterns for code with no tag calls", () => {
    const result = analyze("const x = 5; console.log(x);");
    expect(result.hasStaticPatterns).toBe(false);
    expect(result.patterns.length).toBe(0);
  });

  it("should escape HTML entities in children and attributes", () => {
    const result = analyze('div({ title: "\\"q\\" & <t>", nodes: "a < b & c > d" })');
    expect(result.patterns[0].templateHtml).toBe(
      '<div title="&quot;q&quot; &amp; &lt;t&gt;">a &lt; b &amp; c &gt; d</div>',
    );
  });

  it("should accept quoted keys", () => {
    const result = analyze('div({ "data-id": "7", "class": "c" })');
    expect(result.patterns[0].templateHtml).toBe('<div class="c" data-id="7"></div>');
  });

  it("should reject props the tag factory sanitizes or treats specially", () => {
    for (const props of [
      '{ href: "/x" }',
      '{ style: "color: red" }',
      '{ onclick: "x()" }',
      '{ srcdoc: "<p>" }',
      "{ checked: true }",
      "{ class: 5 }",
      '{ id: "a", ID: "b" }',
    ]) {
      expect(analyze(`a(${props})`).hasStaticPatterns, props).toBe(false);
    }
  });

  it("should reject shorthand, spread, computed keys and non-literal expressions", () => {
    for (const call of [
      "div({ value })",
      "div({ ...props })",
      'div({ [k]: "v" })',
      'div({ title: "a" + x + "b" })',
      "div({ title: `t` })",
      'div({ class: "c" }, [child])',
      'div({ class: "c" }, "a" + b)',
    ]) {
      expect(analyze(call).hasStaticPatterns, call).toBe(false);
    }
  });

  it("should skip method calls, strings, comments and template literals", () => {
    const result = analyze(
      [
        'db.select({ where: "x" });',
        'x.form({ id: "f" });',
        'const s = "div({ class: \\"a\\" })";',
        '// div({ class: "a" })',
        '/* div({ class: "a" }) */',
        'const t = `div({ class: "a" })`;',
      ].join("\n"),
    );
    expect(result.hasStaticPatterns).toBe(false);
  });

  it("should skip a tag name that is shadowed by a local", () => {
    const result = analyze('function f(label) { return label("x"); }\nlabel({ class: "a" });');
    expect(result.hasStaticPatterns).toBe(false);
  });
});
