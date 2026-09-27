/**
 * Execution parity for the `html` template compiler.
 *
 * Every case is a real module. It is run twice against the real runtime —
 * once untouched (the runtime `html` parser renders it) and once after
 * `compileHtmlTemplates` — and the two resulting DOM trees must be identical,
 * down to namespaces, attribute order, text-node boundaries and comment
 * placeholders. Reactive cases are compared again after a signal update.
 *
 * `expect` records whether the compiler is supposed to compile the template or
 * deliberately leave it to the runtime; either way the output must match.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileHtmlTemplates } from "../src/build/compileTemplates";
import { sibuVitePlugin } from "../src/build/vite";
import { signal } from "../src/core/signals/signal";
import { describeRoot, runModule } from "./helpers/buildTransformHarness";

type Scope = Record<string, any>;

interface Case {
  name: string;
  src: string;
  expect: "compiled" | "skipped";
  scope?: () => Scope;
  update?: (s: Scope) => void;
  interact?: (root: Element, s: Scope) => unknown;
}

const HEAD = 'import { html, signal } from "sibujs";\n';

/** Module whose default export renders `template` with the scope `s`. */
function mod(template: string, prelude = ""): string {
  return `${HEAD}${prelude}\nexport default (s) => ${template};\n`;
}

const counterScope = () => {
  const [count, setCount] = signal(1);
  const [id, setId] = signal("a");
  return { count, setCount, id, setId };
};

const CASES: Case[] = [
  {
    name: "static element tree",
    src: mod('html`<div class="card" id="x"><span>hi</span> <b>there</b></div>`'),
    expect: "compiled",
  },
  {
    name: "expression attributes and children",
    src: mod("html`<div class=${s.cls} title=${s.title}>${s.text}</div>`"),
    scope: () => ({ cls: "c", title: 't"q', text: "<b>not markup</b>" }),
    expect: "compiled",
  },
  {
    name: "reactive id attribute binds reactively",
    src: mod("html`<div id=${() => s.id()}>x</div>`"),
    scope: counterScope,
    update: (s) => s.setId("b"),
    expect: "compiled",
  },
  {
    name: "reactive child",
    src: mod("html`<p>Count: ${() => s.count()}!</p>`"),
    scope: counterScope,
    update: (s) => s.setCount(2),
    expect: "compiled",
  },
  {
    name: "custom element, <var>, uppercase tag",
    src: mod('html`<my-widget data-x="1"><var>v</var><DIV>u</DIV></my-widget>`'),
    expect: "compiled",
  },
  {
    name: "svg including tags outside the runtime SVG set",
    src: mod(
      'html`<svg viewBox="0 0 10 10"><circle r="2" /><foreignObject><div>x</div></foreignObject><image href="a.png" /></svg>`',
    ),
    expect: "compiled",
  },
  {
    name: "tags the tag factories block are created like the runtime does",
    src: mod('html`<div><iframe title="t"></iframe><object></object><embed></div>`'),
    expect: "compiled",
  },
  {
    name: "html comments, CDATA, doctype and processing instructions are skipped",
    src: mod("html`<div><!-- note ${s.x} --><b>x</b><![CDATA[ c ]]><!doctype html><?pi x?></div>`"),
    scope: () => ({ x: "unused" }),
    expect: "compiled",
  },
  { name: "bare < in text is literal", src: mod("html`<p>a < b and I <3 you</p>`"), expect: "compiled" },
  {
    name: "unquoted attribute values containing / and ${}",
    src: mod("html`<nav><a href=/about>About</a><a href=/u/${s.id}/edit>Edit</a></nav>`"),
    scope: () => ({ id: 42 }),
    expect: "compiled",
  },
  {
    name: "escape sequences are cooked like the runtime receives them",
    src: mod(
      'html`<p title="a\\tb\\u{1F600}">line\\nnext \\u00e9 \\x41 \\`tick\\` \\${notexpr} back\\\\slash \\\ncontinued</p>`',
    ),
    expect: "compiled",
  },
  {
    name: "CRLF line endings are normalized",
    src: mod('html`<div\r\n  class="a"\r\n>x\r\ny</div>`'),
    expect: "compiled",
  },
  {
    name: "mixed attribute with null / undefined / 0 renders like the runtime",
    src: mod("html`<div class=\"a ${s.n} b ${s.u} c ${s.z}\" data-k='${s.n}'>x</div>`"),
    scope: () => ({ n: null, u: undefined, z: 0 }),
    expect: "compiled",
  },
  {
    name: "static attributes are written raw, exactly like the runtime",
    src: mod('html`<a href="javascript:void(0)" style="color: red" onclick="go()">x</a>`'),
    expect: "compiled",
  },
  {
    name: "dynamic URL / style / on* attributes go through the shared policy",
    src: mod("html`<a href=${s.bad} style=${s.style} onclick=${s.code} title=${s.title}>x</a>`"),
    scope: () => ({ bad: "javascript:alert(1)", style: "color: red", code: "alert(1)", title: null }),
    expect: "compiled",
  },
  {
    name: "attributes named like tag-factory props are plain attributes",
    src: mod('html`<div ref="r" on="o" nodes="n" onElement="e" class=${s.cls} style=${s.st}>x</div>`'),
    scope: () => ({ cls: { active: true }, st: "color: blue" }),
    expect: "compiled",
  },
  {
    name: "aria boolean expressions",
    src: mod("html`<div aria-hidden=${false} aria-busy=${true} hidden=${true} data-off=${false}>x</div>`"),
    expect: "compiled",
  },
  { name: "text-only root returns a wrapper div", src: mod("html`Hello`"), expect: "compiled" },
  { name: "empty template returns an empty wrapper", src: mod("html``"), expect: "compiled" },
  { name: "multiple roots are wrapped", src: mod("html`<li>a</li><li>b</li>`"), expect: "compiled" },
  { name: "text around a single element root", src: mod("html`\n  <div>x</div>\n`"), expect: "compiled" },
  {
    name: "top-level expression is left to the runtime",
    src: mod("html`${s.x}`"),
    scope: () => ({ x: "text" }),
    expect: "skipped",
  },
  {
    name: "top-level function expression is left to the runtime",
    src: mod("html`<b>a</b>${() => s.count()}`"),
    scope: counterScope,
    update: (s) => s.setCount(5),
    expect: "skipped",
  },
  {
    name: "regex, comments and nested templates inside ${}",
    src: mod(
      'html`<p title=${/}/.test("}") ? "yes" : "no"}>${s.text /* } */}${`nested ${"}"}`}${ // }\n s.more }</p>`',
    ),
    scope: () => ({ text: "t", more: "m" }),
    expect: "compiled",
  },
  {
    name: "comma operator expression stays one value",
    src: mod("html`<p>${(s.a, s.b)}|${s.a, s.b}</p>`"),
    scope: () => ({ a: "A", b: "B" }),
    expect: "compiled",
  },
  {
    name: "array, node, boolean, null and function-in-array children",
    src: mod("html`<div>${s.arr}${s.node}${false}${null}${true}${0}</div>`"),
    scope: () => ({
      arr: ["a", document.createElement("i"), null, false, 1, [2, 3], () => "fn"],
      node: document.createElement("em"),
    }),
    expect: "compiled",
  },
  {
    name: "events attach listeners",
    src: mod('html`<button on:click=${s.onClick} on:focus=${s.notFn} on:blur="x">go</button>`'),
    scope: () => {
      const calls: string[] = [];
      return { calls, onClick: () => calls.push("click"), notFn: "nope" };
    },
    interact: (root, s) => {
      root.dispatchEvent(new Event("click"));
      root.dispatchEvent(new Event("focus"));
      return s.calls;
    },
    expect: "compiled",
  },
  {
    name: "local variable shadowing a tag name",
    src: mod("html`<label>${label}</label>`", 'const label = "L"; const div = 5;'),
    expect: "compiled",
  },
  {
    name: "file that already imports tag factories from sibujs",
    src:
      'import { html, div, span as sp } from "sibujs";\n' +
      'export default (s) => div({ class: "outer" }, [html`<div class="inner">${sp("x")}</div>`]);\n',
    expect: "compiled",
  },
  {
    name: "nested html templates inside expressions",
    src: mod("html`<ul>${s.items.map((i) => html`<li class=${i}>${i}</li>`)}</ul>`"),
    scope: () => ({ items: ["a", "b"] }),
    expect: "compiled",
  },
  {
    name: "self-closing non-void elements and stray text",
    src: mod('html`<div><span/>text<p class="x" /></div>`'),
    expect: "compiled",
  },
  {
    name: "boolean and static value attributes",
    src: mod('html`<input disabled value="v" checked>`'),
    expect: "compiled",
  },
  {
    name: "dynamic value is left to the runtime (content-attribute commit)",
    src: mod("html`<input value=${s.v}>`"),
    scope: () => ({ v: "typed" }),
    expect: "skipped",
  },
  {
    name: "whitespace collapsing around expressions",
    src: mod("html`<p>\n   Hello   ${s.name}   world  \n</p>`"),
    scope: () => ({ name: "N" }),
    expect: "compiled",
  },
  {
    name: "style raw text without expressions",
    src: mod("html`<style>.a > .b { color: red }</style>`"),
    expect: "compiled",
  },
  {
    name: "attribute-position expression behaves like the runtime",
    src: mod('html`<div ${s.x} class="a">b</div>`'),
    scope: () => ({ x: "y" }),
    expect: "compiled",
  },
  {
    name: "aliased html import",
    src: 'import { html as h } from "sibujs";\nexport default (s) => h`<b class=${s.c}>x</b>`;\n',
    scope: () => ({ c: "k" }),
    expect: "compiled",
  },
];

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // Both paths may emit the same dev diagnostics (refused on* attributes);
  // they are not what these tests compare.
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("compileHtmlTemplates execution parity with the runtime parser", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const result = compileHtmlTemplates(c.src);
      if (c.expect === "compiled") {
        expect(result.compiledCount).toBeGreaterThan(0);
        expect(result.code).not.toBeNull();
      } else {
        expect(result.compiledCount).toBe(0);
        expect(result.skippedCount).toBeGreaterThan(0);
      }
      const compiledSrc = result.code ?? c.src;

      const sRuntime = c.scope?.() ?? {};
      const sCompiled = c.scope?.() ?? {};
      const runtime = runModule<(s: Scope) => Element>(c.src)(sRuntime);
      const compiled = runModule<(s: Scope) => Element>(compiledSrc)(sCompiled);
      expect(describeRoot(compiled)).toBe(describeRoot(runtime));

      if (c.update) {
        c.update(sRuntime);
        c.update(sCompiled);
        await Promise.resolve();
        expect(describeRoot(compiled)).toBe(describeRoot(runtime));
      }
      if (c.interact) {
        expect(c.interact(compiled, sCompiled)).toEqual(c.interact(runtime, sRuntime));
      }
    });
  }

  it("a template the runtime rejects is not compiled, so it still throws at render time", () => {
    const src = mod("html`<script>${s.code}</script>`");
    const result = compileHtmlTemplates(src);
    expect(result.compiledCount).toBe(0);
    expect(() => runModule<(s: Scope) => Element>(src)({ code: "x" })).toThrow(/raw-text/);
    expect(() => runModule<(s: Scope) => Element>(result.code ?? src)({ code: "x" })).toThrow(/raw-text/);
  });

  it("compiled output renders the same DOM on every call (no shared nodes)", () => {
    const src = mod('html`<div class="a">${s.t}</div>`');
    const render = runModule<(s: Scope) => Element>(compileHtmlTemplates(src).code as string);
    const a = render({ t: 1 });
    const b = render({ t: 2 });
    expect(a).not.toBe(b);
    expect(a.outerHTML).toBe('<div class="a">1</div>');
    expect(b.outerHTML).toBe('<div class="a">2</div>');
  });
});

describe("full Vite pipeline parity (pure annotations + compileTemplates + staticOptimize)", () => {
  const source =
    'import { html, div, span, button, input, tagFactory } from "sibujs";\n' +
    'const hr = tagFactory("hr");\n' +
    "const db = { select: (o) => o, div: (o) => o };\n" +
    'export default (s) => div({ class: "root" }, [\n' +
    '  html`<section class=${s.cls}><span class="x">${s.text}</span></section>`,\n' +
    '  span({ class: "static", id: "sid" }, "static text & <escaped>"),\n' +
    '  button({ type: "button", disabled: false, "data-x": "q\\"uote", "aria-pressed": false }, "b"),\n' +
    '  input({ type: "checkbox", checked: true }),\n' +
    '  span({ title: "a" + s.text }, "concat"),\n' +
    '  span({ ...s.props }, "spread"),\n' +
    '  div({ class: "short", title: s.text }),\n' +
    '  span({ nodes: "legacy nodes prop" }),\n' +
    "  hr(),\n" +
    '  span(JSON.stringify(db.select({ class: "not-a-tag" }))),\n' +
    '  span(JSON.stringify(db.div({ class: "not-a-tag" }))),\n' +
    '  span({ title: s.text }, "div({ class: \\"in a string\\" })"),\n' +
    "]);\n";

  it("renders identically to the untransformed module", () => {
    const plugin = sibuVitePlugin({ devMode: false, staticOptimize: true });
    const out = plugin.transform?.(source, "src/app.js");
    expect(out).not.toBeNull();
    const code = (out as { code: string }).code;
    // Static optimization did fire (so this really tests both passes together)…
    expect(code).toContain("staticTemplate");
    // …and left the non-sibujs calls and string contents alone.
    expect(code).toContain('db.select({ class: "not-a-tag" })');
    expect(code).toContain('db.div({ class: "not-a-tag" })');
    expect(code).toContain('"div({ class: \\"in a string\\" })"');

    const scope = () => ({ cls: "c", text: "T", props: { id: "p" } });
    const runtime = runModule<(s: Scope) => Element>(source)(scope());
    const compiled = runModule<(s: Scope) => Element>(code)(scope());
    expect(describeRoot(compiled)).toBe(describeRoot(runtime));
  });

  it("default production options produce a module that runs and matches the runtime", () => {
    const plugin = sibuVitePlugin();
    plugin.config?.({}, { command: "build", mode: "production" });
    const out = plugin.transform?.(source, "src/app.js");
    const code = out?.code ?? source;
    const scope = () => ({ cls: "c", text: "T", props: { id: "p" } });
    expect(describeRoot(runModule<(s: Scope) => Element>(code)(scope()))).toBe(
      describeRoot(runModule<(s: Scope) => Element>(source)(scope())),
    );
  });
});
