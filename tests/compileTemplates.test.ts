import { describe, expect, it } from "vitest";
import { compileHtmlTemplates } from "../src/build/compileTemplates";
import { runModule } from "./helpers/buildTransformHarness";

const IMPORT = 'import { html } from "sibujs";\n';

/** Compile `body` (with the sibujs html import) and render its default export. */
function render(body: string, scope: Record<string, unknown> = {}): { el: Element; code: string } {
  const result = compileHtmlTemplates(`${IMPORT}${body}`);
  if (result.code === null) throw new Error("nothing was compiled");
  const el = runModule<(s: Record<string, unknown>) => Element>(result.code)(scope);
  return { el, code: result.code };
}

describe("compileHtmlTemplates", () => {
  it("should return null code when no templates found", () => {
    const result = compileHtmlTemplates('import { div } from "sibujs";\nconst x = div({ class: "foo" })');
    expect(result.code).toBeNull();
    expect(result.compiledCount).toBe(0);
  });

  it("should compile a simple static template", () => {
    const { el, code } = render('export default () => html`<div class="hello">world</div>`;');
    expect(code).not.toContain("html`");
    expect(el.outerHTML).toBe('<div class="hello">world</div>');
  });

  it("should compile template with expression attributes", () => {
    const { el } = render("export default (s) => html`<div class=${s.cls}>text</div>`;", { cls: "k" });
    expect(el.outerHTML).toBe('<div class="k">text</div>');
  });

  it("should compile template with expression children", () => {
    const { el } = render("export default (s) => html`<span>${() => s.count}</span>`;", { count: 3 });
    expect(el.outerHTML).toBe("<span><!---->3</span>");
  });

  it("should compile nested elements", () => {
    const result = compileHtmlTemplates(`${IMPORT}const el = html\`<div><span>inner</span></div>\`;`);
    expect(result.usedTags.has("div")).toBe(true);
    expect(result.usedTags.has("span")).toBe(true);
  });

  it("should compile event handlers", () => {
    const calls: string[] = [];
    const { el } = render("export default (s) => html`<button on:click=${s.handler}>Click</button>`;", {
      handler: () => calls.push("clicked"),
    });
    el.dispatchEvent(new Event("click"));
    expect(calls).toEqual(["clicked"]);
    expect(el.hasAttribute("on:click")).toBe(false);
  });

  it("should handle void elements", () => {
    const { el } = render('export default () => html`<input type="text" />`;');
    expect(el.outerHTML).toBe('<input type="text">');
  });

  it("should detect SVG tags", () => {
    const result = compileHtmlTemplates(`${IMPORT}const el = html\`<svg><circle r="10" /></svg>\`;`);
    expect(result.usesSvg).toBe(true);
    const { el } = render('export default () => html`<svg><circle r="10" /></svg>`;');
    expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(el.firstElementChild?.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });

  it("should compile multiple templates in same file", () => {
    const code = [IMPORT, "const a = html`<div>first</div>`;", "const b = html`<span>second</span>`;"].join("\n");
    const result = compileHtmlTemplates(code);
    expect(result.compiledCount).toBe(2);
    expect(result.code).not.toContain("html`");
  });

  it("should handle mixed static and expression attributes", () => {
    const { el } = render('export default (s) => html`<div class="base ${s.extra}">text</div>`;', { extra: "x" });
    expect(el.getAttribute("class")).toBe("base x");
  });

  it("should handle boolean attributes", () => {
    const { el } = render("export default () => html`<input disabled />`;");
    expect(el.getAttribute("disabled")).toBe("");
  });

  it("only compiles `html` imported from sibujs", () => {
    expect(compileHtmlTemplates("const el = html`<div></div>`;").code).toBeNull();
    expect(compileHtmlTemplates('import { html } from "lit";\nconst el = html`<div></div>`;').code).toBeNull();
    expect(
      compileHtmlTemplates('import { html } from "sibujs";\nconst el = foo.html`<div></div>`;').compiledCount,
    ).toBe(0);
  });
});
