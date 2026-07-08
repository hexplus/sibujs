import { describe, expect, it } from "vitest";
import { analyzeStaticTemplates } from "../src/build/staticAnalysis";

describe("analyzeStaticTemplates", () => {
  it("should detect a fully static div call", () => {
    const code = 'div({ class: "card", nodes: "Hello" })';
    const result = analyzeStaticTemplates(code);
    expect(result.hasStaticPatterns).toBe(true);
    expect(result.patterns.length).toBe(1);
    expect(result.patterns[0].tag).toBe("div");
    expect(result.patterns[0].templateHtml).toBe('<div class="card">Hello</div>');
  });

  it("should NOT detect calls with arrow function props", () => {
    const code = 'div({ class: () => activeClass(), nodes: "Hello" })';
    const result = analyzeStaticTemplates(code);
    expect(result.hasStaticPatterns).toBe(false);
  });

  it("should NOT detect calls with event handlers", () => {
    const code = 'button({ on: { click: handleClick }, nodes: "Click" })';
    const result = analyzeStaticTemplates(code);
    expect(result.hasStaticPatterns).toBe(false);
  });

  it("should NOT detect calls with ref", () => {
    const code = 'div({ ref: myRef, nodes: "Content" })';
    const result = analyzeStaticTemplates(code);
    expect(result.hasStaticPatterns).toBe(false);
  });

  it("should detect multiple static patterns", () => {
    const code = `
      const header = h1({ nodes: "Title" });
      const body = p({ class: "text", nodes: "Content" });
    `;
    const result = analyzeStaticTemplates(code);
    expect(result.patterns.length).toBe(2);
  });

  it("should handle void elements", () => {
    const code = "br({})";
    const result = analyzeStaticTemplates(code);
    expect(result.hasStaticPatterns).toBe(true);
    expect(result.patterns[0].templateHtml).toBe("<br />");
  });

  it("should detect static boolean and number props", () => {
    const code = "input({ disabled: true, tabindex: 0 })";
    const result = analyzeStaticTemplates(code);
    expect(result.hasStaticPatterns).toBe(true);
  });

  it("should NOT detect calls with variable references as values", () => {
    const code = 'div({ class: className, nodes: "Hello" })';
    const result = analyzeStaticTemplates(code);
    expect(result.hasStaticPatterns).toBe(false);
  });

  it("should NOT detect calls with function keyword props", () => {
    const code = 'div({ class: function() { return "x"; } })';
    const result = analyzeStaticTemplates(code);
    expect(result.hasStaticPatterns).toBe(false);
  });

  it("should handle id attribute", () => {
    const code = 'div({ id: "main", nodes: "Hello" })';
    const result = analyzeStaticTemplates(code);
    expect(result.patterns[0].templateHtml).toBe('<div id="main">Hello</div>');
  });

  it("should return correct start and end positions", () => {
    const prefix = "const el = ";
    const call = 'span({ nodes: "X" })';
    const code = prefix + call;
    const result = analyzeStaticTemplates(code);
    expect(result.patterns[0].start).toBe(prefix.length);
    expect(result.patterns[0].end).toBe(prefix.length + call.length);
  });

  it("should NOT detect non-HTML tag names", () => {
    const code = 'myComponent({ class: "x", nodes: "Y" })';
    const result = analyzeStaticTemplates(code);
    expect(result.hasStaticPatterns).toBe(false);
  });

  it("should return empty patterns for code with no tag calls", () => {
    const code = "const x = 5; console.log(x);";
    const result = analyzeStaticTemplates(code);
    expect(result.hasStaticPatterns).toBe(false);
    expect(result.patterns.length).toBe(0);
  });

  it("should escape HTML entities in children", () => {
    const code = 'div({ nodes: "a < b & c > d" })';
    const result = analyzeStaticTemplates(code);
    expect(result.patterns[0].templateHtml).toContain("&lt;");
    expect(result.patterns[0].templateHtml).toContain("&amp;");
    expect(result.patterns[0].templateHtml).toContain("&gt;");
  });
});
