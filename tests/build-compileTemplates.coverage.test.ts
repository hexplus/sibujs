import { describe, expect, it } from "vitest";
import { compileHtmlTemplates } from "../src/build/compileTemplates";
import { runModule } from "./helpers/buildTransformHarness";

const IMPORT = 'import { html } from "sibujs";\n';

function compile(body: string) {
  return compileHtmlTemplates(`${IMPORT}${body}`);
}

function render(body: string, scope: Record<string, unknown> = {}): Element {
  const code = compile(body).code;
  if (code === null) throw new Error("nothing was compiled");
  return runModule<(s: Record<string, unknown>) => Element>(code)(scope);
}

describe("compileHtmlTemplates - coverage edge cases", () => {
  it("passes every expression to a module-level construction function, in order", () => {
    const result = compile("const el = html`<div class=${cls} id=${theId}>${child}</div>`;");
    expect(result.code).toContain("__sibujs$t0((cls), (theId), (child))");
    expect(result.code).toContain("function __sibujs$t0(v0, v1, v2)");
  });

  it("preserves complex original expression source", () => {
    const result = compile("const el = html`<div class=${a ? `x ${y}` : 'z'}>${items.map(i => i)}</div>`;");
    expect(result.code).toContain("(a ? `x ${y}` : 'z')");
    expect(result.code).toContain("(items.map(i => i))");
  });

  it("handles mixed text and expression children with whitespace collapsing", () => {
    const el = render("export default (s) => html`<p>Hello   ${s.name}   world</p>`;", { name: "N" });
    expect(el.outerHTML).toBe("<p>Hello N world</p>");
    expect(el.childNodes.length).toBe(3);
  });

  it("creates svg elements in the SVG namespace, with attributes intact", () => {
    const el = render("export default (s) => html`<svg width=${s.w}><circle r=${s.r} /></svg>`;", { w: 5, r: 2 });
    expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(el.getAttribute("width")).toBe("5");
    expect(el.firstElementChild?.getAttribute("r")).toBe("2");
  });

  it("handles escape sequences inside the template literal", () => {
    const el = render('export default () => html`<div title="a\\`b">x\\ny</div>`;');
    expect(el.getAttribute("title")).toBe("a`b");
    expect(el.textContent).toBe("x y");
  });

  it("returns null code for an unterminated template literal", () => {
    const result = compile("const el = html`<div>unterminated");
    expect(result.code).toBeNull();
    expect(result.compiledCount).toBe(0);
  });

  it("handles a mixed-value attribute (static + expr concatenation)", () => {
    const el = render('export default (s) => html`<div class="base ${s.extra} end">x</div>`;', { extra: null });
    expect(el.getAttribute("class")).toBe("base  end");
  });

  it("handles unquoted attribute values, including `/`", () => {
    const el = render("export default () => html`<a href=/about/team type=text>x</a>`;");
    expect(el.outerHTML).toBe('<a href="/about/team" type="text">x</a>');
  });

  it("handles nested expressions inside attribute object literals", () => {
    const result = compile("const el = html`<div data-x=${ { a: 1, b: { c: 2 } } }>x</div>`;");
    expect(result.code).toContain("{ a: 1, b: { c: 2 } }");
  });

  it("handles a self-closing non-void element", () => {
    const el = render("export default () => html`<div class=${'c'} />`;");
    expect(el.outerHTML).toBe('<div class="c"></div>');
  });

  it("counts templates compiled across the file", () => {
    const result = compile(
      [
        "const a = html`<div>${x}</div>`;",
        "const b = html`<span class=${c}>${y}</span>`;",
        "const c = html`<p>plain</p>`;",
      ].join("\n"),
    );
    expect(result.compiledCount).toBe(3);
    expect(result.code).not.toContain("html`");
  });

  it("ignores identifiers that merely start with html", () => {
    const result = compile("const x = htmlFoo`<div></div>`;");
    expect(result.code).toBeNull();
  });

  it("leaves the whole file alone when the html import may be shadowed", () => {
    const result = compile("function f(html) { return html`<b></b>`; }\nconst g = html`<i></i>`;");
    expect(result.code).toBeNull();
  });

  it("leaves the file alone when it cannot be scanned with confidence", () => {
    const result = compile("const s = 'unterminated\nconst g = html`<i></i>`;");
    expect(result.code).toBeNull();
  });

  it("appends aliased imports only for helpers it uses", () => {
    const staticOnly = compile("const a = html`<p>plain</p>`;").code ?? "";
    expect(staticOnly).not.toContain("sibujs/ui");
    const dynamic = compile("const a = html`<p title=${t}>${c}</p>`;").code ?? "";
    expect(dynamic).toContain(
      'import { Fragment as __sibujs$Fragment, dispose as __sibujs$dispose, registerDisposer as __sibujs$registerDisposer } from "sibujs";',
    );
    const executed = compile("const a = html`${t}`;").code ?? "";
    expect(executed).toContain('import { __renderParsedTemplate as __sibujs$run } from "sibujs";');
    expect(executed).not.toContain("sibujs/ui");
    expect(dynamic).toContain('import { bindAttrs as __sibujs$bindAttrs } from "sibujs/ui";');
  });

  it("picks a fresh prefix when the file already uses the default one", () => {
    const result = compile("const __sibujs$t0 = 1;\nconst a = html`<p>${__sibujs$t0}</p>`;");
    expect(result.code).toContain("__sibujs1$t0(");
  });
});

describe("compileHtmlTemplates - multi-root templates (regression)", () => {
  it("keeps every top-level sibling node (does not drop after the first)", () => {
    const el = render("export default () => html`<li>a</li><li>b</li>`;");
    expect(el.outerHTML).toBe("<div><li>a</li><li>b</li></div>");
  });

  it("keeps multiple roots that contain expressions", () => {
    const el = render("export default (s) => html`<span>${s.a}</span><span>${s.b}</span>`;", { a: 1, b: 2 });
    expect(el.outerHTML).toBe("<div><span>1</span><span>2</span></div>");
  });
});
