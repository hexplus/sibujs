/**
 * Attribute-security parity certification.
 *
 * INVARIANT: equivalent attribute APIs share one security policy. A value that
 * is refused on the reactive path must be refused on the static path, on the
 * SVG helper, and through every public convenience wrapper. Divergence here is
 * the whole bug class: an application that switches `href: url` to
 * `href: () => url` (or renders the same icon through `svgElement`) must not
 * silently change its security posture.
 */

import { describe, expect, it } from "vitest";
import { svgElement } from "../src/platform/customElement";
import { bindAttribute } from "../src/reactivity/bindAttribute";
import { bindAttrs, bindBoolAttr, bindData } from "../src/ui/reactiveAttr";

// Values whose handling must be identical across every writer.
const DANGEROUS_URLS = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "java\tscript:alert(1)",
  "javascript:alert(1)",
  "vbscript:msgbox(1)",
  "data:text/html,<script>alert(1)</script>",
];

const SAFE_URLS = ["https://example.com/x", "/relative/path", "mailto:a@b.com", "#anchor"];

describe("attribute security parity — static vs reactive bindAttrs", () => {
  for (const url of DANGEROUS_URLS) {
    it(`refuses ${JSON.stringify(url)} identically on both href paths`, () => {
      const staticEl = document.createElement("a");
      const reactiveEl = document.createElement("a");

      bindAttrs(staticEl, { href: url });
      bindAttrs(reactiveEl, { href: () => url });

      expect(staticEl.getAttribute("href")).toBe(reactiveEl.getAttribute("href"));
      // And the shared verdict must actually be "blocked".
      expect(staticEl.getAttribute("href") ?? "").not.toContain("script:");
    });
  }

  for (const url of SAFE_URLS) {
    it(`preserves ${JSON.stringify(url)} identically on both href paths`, () => {
      const staticEl = document.createElement("a");
      const reactiveEl = document.createElement("a");

      bindAttrs(staticEl, { href: url });
      bindAttrs(reactiveEl, { href: () => url });

      expect(staticEl.getAttribute("href")).toBe(url);
      expect(reactiveEl.getAttribute("href")).toBe(url);
    });
  }

  it("refuses a static on* handler string exactly as the reactive path does", () => {
    const staticEl = document.createElement("img");
    const reactiveEl = document.createElement("img");

    bindAttrs(staticEl, { onerror: "alert(1)" });
    bindAttrs(reactiveEl, { onerror: () => "alert(1)" });

    expect(reactiveEl.hasAttribute("onerror")).toBe(false);
    expect(staticEl.hasAttribute("onerror")).toBe(false);
  });

  it("refuses a static onclick handler string", () => {
    const el = document.createElement("button");
    bindAttrs(el, { onclick: "alert(1)" });
    expect(el.hasAttribute("onclick")).toBe(false);
  });

  it("refuses an on* attribute set through the boolean path", () => {
    const el = document.createElement("button");
    bindAttrs(el, { onclick: true });
    expect(el.hasAttribute("onclick")).toBe(false);
  });

  it("sanitizes a static style declaration list like the reactive one", () => {
    const staticEl = document.createElement("div");
    const reactiveEl = document.createElement("div");
    const css = "background: url(https://attacker.example/leak); color: red";

    bindAttrs(staticEl, { style: css });
    bindAttrs(reactiveEl, { style: () => css });

    expect(staticEl.getAttribute("style")).toBe(reactiveEl.getAttribute("style"));
    expect(staticEl.getAttribute("style") ?? "").not.toContain("url(");
  });

  it("validates a static srcset candidate list like the reactive one", () => {
    const staticEl = document.createElement("img");
    const reactiveEl = document.createElement("img");
    const srcset = "javascript:alert(1) 1x, https://ok.example/a.png 2x";

    bindAttrs(staticEl, { srcset });
    bindAttrs(reactiveEl, { srcset: () => srcset });

    expect(staticEl.getAttribute("srcset")).toBe(reactiveEl.getAttribute("srcset"));
    expect(staticEl.getAttribute("srcset") ?? "").not.toContain("javascript:");
  });

  it("blocks a static formaction the same way as the reactive one", () => {
    const staticEl = document.createElement("button");
    const reactiveEl = document.createElement("button");

    bindAttrs(staticEl, { formaction: "javascript:alert(1)" });
    bindAttrs(reactiveEl, { formaction: () => "javascript:alert(1)" });

    expect(staticEl.getAttribute("formaction")).toBe(reactiveEl.getAttribute("formaction"));
    expect(staticEl.getAttribute("formaction") ?? "").not.toContain("javascript:");
  });

  // CSS escape sequences are how a payload hides from a literal-token scan:
  // `\75 rl(` and `u\rl(` both read as `url(` to a browser. The sanitizer
  // decodes all three escape productions before scanning, and these assert the
  // decoding reaches the static/convenience writers too, not just the reactive
  // one it was originally built for.
  const ESCAPED_CSS = [
    "background: \\75 rl(https://attacker.example/leak)",
    "background: u\\rl(https://attacker.example/leak)",
    "background: \\000075rl(https://attacker.example/leak)",
    "width: e\\78 pression(alert(1))",
  ];

  for (const css of ESCAPED_CSS) {
    it(`blocks an escaped CSS payload identically on both paths: ${JSON.stringify(css.slice(0, 26))}`, () => {
      const staticEl = document.createElement("div");
      const reactiveEl = document.createElement("div");

      bindAttrs(staticEl, { style: css });
      bindAttrs(reactiveEl, { style: () => css });

      expect(staticEl.getAttribute("style")).toBe(reactiveEl.getAttribute("style"));
      expect(staticEl.getAttribute("style") ?? "").not.toContain("attacker.example");
    });
  }

  it("leaves safe aria/data attributes untouched on the static path", () => {
    const el = document.createElement("div");
    bindAttrs(el, { "aria-label": "Close", "data-id": "42", title: "<b>ok</b>" });
    expect(el.getAttribute("aria-label")).toBe("Close");
    expect(el.getAttribute("data-id")).toBe("42");
    expect(el.getAttribute("title")).toBe("<b>ok</b>");
  });

  it("keeps static boolean attribute semantics", () => {
    const el = document.createElement("input");
    bindAttrs(el, { required: true });
    expect(el.getAttribute("required")).toBe("");
    bindAttrs(el, { required: false });
    expect(el.hasAttribute("required")).toBe(false);
  });

  it("refuses an on* attribute through bindBoolAttr (static and reactive)", () => {
    const staticEl = document.createElement("button");
    const reactiveEl = document.createElement("button");

    bindBoolAttr(staticEl, "onclick", true);
    bindBoolAttr(reactiveEl, "onclick", () => true);

    expect(staticEl.hasAttribute("onclick")).toBe(false);
    expect(reactiveEl.hasAttribute("onclick")).toBe(false);
  });

  it("removes the attribute for a null/undefined reactive value", () => {
    // Previously `String(null)` reached `setAttribute`, so a getter returning
    // null wrote the literal text "null" — e.g. `title="null"` shown as a
    // tooltip. Absence is the only sensible reading of a null value, and it
    // matches what the tag factory and `enhance()`'s `attr()` already did.
    const el = document.createElement("div");
    el.setAttribute("title", "before");
    bindAttribute(el, "title", () => null);
    expect(el.hasAttribute("title")).toBe(false);

    const el2 = document.createElement("div");
    bindAttribute(el2, "data-x", () => undefined);
    expect(el2.hasAttribute("data-x")).toBe(false);
  });

  it("still writes the string 'null' when that is genuinely the value", () => {
    const el = document.createElement("div");
    bindAttribute(el, "title", () => "null");
    expect(el.getAttribute("title")).toBe("null");
  });

  it("sanitizes bindData static values through the shared policy", () => {
    const staticEl = document.createElement("div");
    const reactiveEl = document.createElement("div");

    bindData(staticEl, "href", "javascript:alert(1)");
    bindData(reactiveEl, "href", () => "javascript:alert(1)");

    // data-* is inert, so both must simply agree.
    expect(staticEl.getAttribute("data-href")).toBe(reactiveEl.getAttribute("data-href"));
  });
});

describe("attribute security parity — svgElement", () => {
  it("does not turn a string onload into an SVG event attribute", () => {
    const el = svgElement("svg", { onload: "alert(1)" });
    expect(el.hasAttribute("onload")).toBe(false);
  });

  it("does not turn a string onclick into an SVG event attribute", () => {
    const el = svgElement("rect", { onclick: "alert(1)" });
    expect(el.hasAttribute("onclick")).toBe(false);
  });

  it("does not turn a mixed-case ONLOAD into an SVG event attribute", () => {
    const el = svgElement("svg", { ONLOAD: "alert(1)" });
    expect(el.hasAttribute("ONLOAD")).toBe(false);
    expect(el.hasAttribute("onload")).toBe(false);
  });

  it("rejects a javascript: href", () => {
    const el = svgElement("a", { href: "javascript:alert(1)" });
    expect(el.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("rejects a javascript: xlink:href", () => {
    const el = svgElement("use", { "xlink:href": "javascript:alert(1)" });
    const value = el.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? el.getAttribute("xlink:href") ?? "";
    expect(value).not.toContain("javascript:");
  });

  it("preserves a safe xlink:href in the xlink namespace", () => {
    const el = svgElement("use", { "xlink:href": "#icon-star" });
    expect(el.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe("#icon-star");
  });

  it("sanitizes an unsafe style declaration list", () => {
    const el = svgElement("rect", { style: "background: url(https://attacker.example/leak)" });
    expect(el.getAttribute("style") ?? "").not.toContain("url(");
  });

  it("keeps ordinary aria/data/presentation attributes", () => {
    const el = svgElement("circle", {
      cx: "50",
      cy: "50",
      r: "40",
      fill: "red",
      "aria-label": "dot",
      "data-id": "7",
    });
    expect(el.getAttribute("cx")).toBe("50");
    expect(el.getAttribute("fill")).toBe("red");
    expect(el.getAttribute("aria-label")).toBe("dot");
    expect(el.getAttribute("data-id")).toBe("7");
  });

  it("still wires function handlers through addEventListener", () => {
    let clicks = 0;
    const el = svgElement("rect", { onclick: () => clicks++ });
    el.dispatchEvent(new Event("click"));
    expect(clicks).toBe(1);
    // …and never as an attribute.
    expect(el.hasAttribute("onclick")).toBe(false);
  });

  it("agrees with bindAttrs on a safe href", () => {
    const svg = svgElement("a", { href: "https://example.com/x" });
    const anchor = document.createElement("a");
    bindAttrs(anchor, { href: "https://example.com/x" });
    expect(svg.getAttribute("href")).toBe(anchor.getAttribute("href"));
  });

  it("agrees with bindAttribute on a dangerous href verdict", () => {
    const svg = svgElement("a", { href: "javascript:alert(1)" });
    const anchor = document.createElement("a");
    bindAttribute(anchor, "href", () => "javascript:alert(1)");
    expect(svg.getAttribute("href")).toBe(anchor.getAttribute("href"));
  });
});
