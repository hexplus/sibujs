/**
 * Dynamic `html` attributes must use the SHARED commit policy.
 *
 * The tagged-template executor carried its own attribute rules — `srcset`,
 * then URL attributes, then "write it". That list is a copy of the shared
 * policy with `style` missing, so `html\`<div style=${untrusted}>\`` never
 * reached `sanitizeStyleAttribute()` even though the shared sanitizer's own
 * documentation claims html`` expressions funnel through it. A duplicated
 * policy is a policy that drifts; this suite pins the template path to the
 * same primitive every other writer uses.
 *
 * Static template text is deliberately NOT covered by this: an attribute the
 * developer typed literally into their own source is developer-controlled, the
 * same as hand-written markup. Only expressions are runtime data.
 */

import { describe, expect, it } from "vitest";
import { html } from "../src/core/rendering/htm";
import { signal } from "../src/core/signals/signal";

const el = (node: unknown) => node as HTMLElement;

describe("html style attributes go through the declaration-list sanitizer", () => {
  it("strips url() from a single expression while keeping safe declarations", () => {
    const node = el(
      html`<div style=${"color: red; background: url(https://attacker.example/x); font-weight: bold"}></div>`,
    );
    const style = node.getAttribute("style") ?? "";

    expect(style).toContain("color");
    expect(style).toContain("font-weight");
    expect(style, "url() survived a dynamic html style").not.toContain("url(");
  });

  it("strips url() from a MIXED expression while keeping safe declarations", () => {
    const node = el(html`<div style="color:red;${"background: url(https://attacker.example/x)"}"></div>`);
    const style = node.getAttribute("style") ?? "";

    expect(style).toContain("color");
    expect(style).not.toContain("url(");
  });

  const DANGEROUS: Array<{ label: string; css: string; absent: string }> = [
    { label: "url()", css: "background: url(https://attacker.example/x)", absent: "url(" },
    { label: "expression()", css: "width: expression(alert(1))", absent: "expression(" },
    { label: "behavior", css: "behavior: url(#default#time2)", absent: "behavior" },
    { label: "-moz-binding", css: "-moz-binding: url(https://attacker.example/x.xml)", absent: "-moz-binding" },
    { label: "escaped url()", css: "background: \\75 rl(https://attacker.example/x)", absent: "attacker.example" },
  ];

  for (const { label, css, absent } of DANGEROUS) {
    it(`removes ${label} from a single expression`, () => {
      const node = el(html`<div style=${css}></div>`);
      expect(node.getAttribute("style") ?? "").not.toContain(absent);
    });

    it(`removes ${label} from a mixed expression`, () => {
      const node = el(html`<div style="color:red;${css}"></div>`);
      const style = node.getAttribute("style") ?? "";
      expect(style).not.toContain(absent);
      expect(style).toContain("color");
    });
  }

  it("preserves an entirely safe dynamic style", () => {
    const node = el(html`<div style=${"color: blue; margin: 4px"}></div>`);
    const style = node.getAttribute("style") ?? "";
    expect(style).toContain("color");
    expect(style).toContain("margin");
  });

  it("applies the policy to a mixed-case STYLE attribute", () => {
    const node = el(html`<div STYLE=${"background: url(https://attacker.example/x); color: red"}></div>`);
    const style = node.getAttribute("style") ?? node.getAttribute("STYLE") ?? "";
    expect(style).not.toContain("url(");
    expect(style).toContain("color");
  });

  it("sanitizes a function-valued reactive style on first render", () => {
    const [css] = signal("background: url(https://attacker.example/x); color: red");
    const node = el(html`<div style=${() => css()}></div>`);
    const style = node.getAttribute("style") ?? "";
    expect(style).not.toContain("url(");
    expect(style).toContain("color");
  });

  it("sanitizes a reactive style on update: safe → unsafe", () => {
    const [css, setCss] = signal("color: red");
    const node = el(html`<div style=${() => css()}></div>`);
    expect(node.getAttribute("style") ?? "").toContain("color");

    setCss("background: url(https://attacker.example/x)");
    expect(node.getAttribute("style") ?? "", "an update bypassed the sanitizer").not.toContain("url(");
  });

  it("restores a safe style on update: unsafe → safe", () => {
    const [css, setCss] = signal("background: url(https://attacker.example/x)");
    const node = el(html`<div style=${() => css()}></div>`);
    expect(node.getAttribute("style") ?? "").not.toContain("url(");

    setCss("color: green");
    expect(node.getAttribute("style") ?? "").toContain("color");
  });
});

describe("html keeps every other shared policy", () => {
  it("blocks javascript: href in a single expression", () => {
    const node = el(html`<a href=${"javascript:alert(1)"}>x</a>`);
    expect(node.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("blocks a javascript: href assembled from a mixed expression", () => {
    const node = el(html`<a href="java${"script"}:alert(1)">x</a>`);
    expect(node.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("validates srcset candidates in a single expression", () => {
    const node = el(html`<img alt="x" srcset=${"javascript:alert(1) 1x, https://ok.example/a.png 2x"} />`);
    expect(node.getAttribute("srcset") ?? "").not.toContain("javascript:");
  });

  it("blocks javascript: src", () => {
    const node = el(html`<img alt="x" src=${"javascript:alert(1)"} />`);
    expect(node.getAttribute("src") ?? "").not.toContain("javascript:");
  });

  it("refuses an on* attribute expression", () => {
    const node = el(html`<button onclick=${"alert(1)"}>x</button>`);
    expect(node.hasAttribute("onclick")).toBe(false);
  });

  it("removes the attribute for a null expression", () => {
    const node = el(html`<div title=${null}></div>`);
    expect(node.hasAttribute("title")).toBe(false);
  });

  it("keeps safe values and inert attributes untouched", () => {
    const node = el(html`<a href=${"https://example.com/x"} title=${"<b>ok</b>"} data-id=${"7"}>x</a>`);
    expect(node.getAttribute("href")).toBe("https://example.com/x");
    expect(node.getAttribute("title")).toBe("<b>ok</b>");
    expect(node.getAttribute("data-id")).toBe("7");
  });

  it("leaves fully static developer-authored attributes alone", () => {
    // No expression anywhere: this is source the developer typed, at the same
    // trust level as hand-written markup.
    const node = el(html`<div style="color: red" title="static"></div>`);
    expect(node.getAttribute("style")).toBe("color: red");
    expect(node.getAttribute("title")).toBe("static");
  });
});
