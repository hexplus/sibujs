/**
 * What SSR emits for SVG — pinned against a hostile tree.
 *
 * `renderToString` / `renderToStream` serialize SVG (and MathML) as markup
 * since 4.12; before that a non-HTML element was emitted as its escaped text.
 * This file proves the change widened nothing a runtime value can inject:
 *
 *   - `on*` attributes never reach the output;
 *   - URL attributes (`href`, `xlink:href`) pass the same allowlist as the
 *     client writers, so a `javascript:` link is omitted;
 *   - an SVG animation may not target a URL or handler attribute;
 *   - `<script>` and `<style>` — SVG ones included — are stripped, and
 *     `<foreignObject>` content follows the HTML rules;
 *   - text and attribute values are escaped;
 *   - string and stream renderers agree byte for byte;
 *   - hydration rebuilds the SVG in the SVG namespace, under the client policy.
 */

import { describe, expect, it } from "vitest";
import { html } from "../src/core/rendering/htm";
import { div } from "../src/core/rendering/html";
import { SVG_NS, tagFactory } from "../src/core/rendering/tagFactory";
import { svgElement } from "../src/platform/customElement";
import { collectStream, hydrate, renderToStream, renderToString } from "../src/platform/ssr";

const XLINK_NS = "http://www.w3.org/1999/xlink";

/** A hostile but framework-built SVG subtree, plus raw-built foreign content. */
function hostileSvg(): Element {
  const root = svgElement("svg", { viewBox: "0 0 10 10", onload: "alert(1)" });
  root.appendChild(svgElement("use", { href: "#icon", "xlink:href": "#icon" }));
  root.appendChild(svgElement("image", { href: "https://example.com/a.png" }));
  const a = svgElement("a", { href: "/next" }, svgElement("text", {}, "Label <b>&amp;</b> \"q\" 'q'"));
  root.appendChild(a);
  root.appendChild(tagFactory("animate", SVG_NS)({ attributeName: "fill", to: "red" }));
  root.appendChild(tagFactory("set", SVG_NS)({ attributeName: "opacity", to: "1" }));
  const fo = svgElement("foreignObject", { width: "10", height: "10" });
  fo.appendChild(div({ style: "color: red" }, "<img src=x onerror=alert(1)>"));
  root.appendChild(fo);
  // Foreign DOM the framework never vetted: a live SVG script and style, a
  // `javascript:` link and an animation aimed at a link destination.
  const script = document.createElementNS(SVG_NS, "script");
  script.textContent = "alert('svg script')";
  script.setAttributeNS(XLINK_NS, "xlink:href", "javascript:alert(1)");
  root.appendChild(script);
  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = "@import url(https://attacker.example/x.css);";
  root.appendChild(style);
  const evil = document.createElementNS(SVG_NS, "a");
  evil.setAttribute("href", "javascript:alert(1)");
  evil.setAttributeNS(XLINK_NS, "xlink:href", "javascript:alert(2)");
  evil.setAttribute("onclick", "alert(3)");
  root.appendChild(evil);
  const set = document.createElementNS(SVG_NS, "set");
  set.setAttribute("attributeName", "href");
  set.setAttribute("to", "javascript:alert(1)");
  a.appendChild(set);
  return root;
}

function parse(markup: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${markup}`, "text/html");
}

describe("SVG SSR — serialized under the runtime policy", () => {
  it("emits the SVG and nothing executable; string and stream agree", async () => {
    const tree = div([hostileSvg()]);
    const string = renderToString(tree);
    expect(await collectStream(renderToStream(tree))).toBe(string);

    const doc = parse(string);
    const svg = doc.querySelector("svg") as Element;
    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(svg.getAttribute("viewBox")).toBe("0 0 10 10");
    expect(doc.querySelectorAll("script, style, img, [onerror], [onload], [onclick]")).toHaveLength(0);
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      expect(el.getAttribute("href") ?? "", el.localName).not.toMatch(/javascript:/i);
      expect(el.getAttributeNS(XLINK_NS, "href") ?? "", el.localName).not.toMatch(/javascript:/i);
    }
    // The animation aimed at `href` loses its target, exactly as the client
    // writers refuse it; its `to` value is then inert text, as it is on the client.
    for (const anim of Array.from(doc.querySelectorAll("set, animate"))) {
      expect(anim.getAttribute("attributeName") ?? "", "animation target").not.toMatch(/href|^on/i);
    }
    expect(string.match(/javascript:/g)).toHaveLength(1);
    expect(string).toContain('<set to="javascript:alert(1)" data-sibu-ssr="true" />');
    for (const needle of ["onload", "onclick", "attacker.example", "alert('svg script')"]) {
      expect(string, needle).not.toContain(needle);
    }
  });

  it("keeps the safe URLs and animations", () => {
    const doc = parse(renderToString(div([hostileSvg()])));
    const use = doc.querySelector("use") as Element;
    expect(use.getAttribute("href")).toBe("#icon");
    expect(use.getAttributeNS(XLINK_NS, "href")).toBe("#icon");
    expect(doc.querySelector("image")?.getAttribute("href")).toBe("https://example.com/a.png");
    expect(doc.querySelector('a[href="/next"]')).not.toBeNull();
    expect(doc.querySelector('animate[attributeName="fill"]')).not.toBeNull();
    expect(doc.querySelector('set[attributeName="opacity"]')).not.toBeNull();
    // The hostile link survives as an inert element without a destination.
    const links = Array.from(doc.querySelectorAll("svg > a"));
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/next", null]);
  });

  it("escapes the SVG text and the foreignObject HTML it emits", () => {
    const out = renderToString(div([hostileSvg()]));
    expect(out).toContain("Label &lt;b&gt;&amp;amp;&lt;/b&gt;");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    const doc = parse(out);
    const foDiv = doc.querySelector("foreignObject > div") as Element;
    expect(foDiv.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(foDiv.getAttribute("style")).toMatch(/^color: red;?$/);
  });

  it("html`` SVG takes the same path", async () => {
    const tree = html`<div><svg viewBox="0 0 1 1"><circle r="1" style="fill:red"></circle><text>t</text></svg></div>`;
    const string = renderToString(tree);
    expect(await collectStream(renderToStream(tree))).toBe(string);
    const doc = parse(string);
    expect(doc.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 1 1");
    expect(doc.querySelector("circle")?.getAttribute("r")).toBe("1");
    expect(doc.querySelector("text")?.textContent).toBe("t");
  });

  it("hydration rebuilds the SVG in the SVG namespace, under the client policy", () => {
    const container = document.createElement("div");
    const app = () =>
      div([
        svgElement(
          "svg",
          { viewBox: "0 0 10 10" },
          svgElement("use", { href: "#icon", "xlink:href": "javascript:alert(1)" }),
        ),
      ]) as HTMLElement;
    container.innerHTML = renderToString(app());
    // The server markup already carries the graphic.
    expect(container.querySelector("svg")?.namespaceURI).toBe(SVG_NS);
    hydrate(app, container);
    const svg = container.querySelector("svg") as Element;
    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(svg.getAttribute("viewBox")).toBe("0 0 10 10");
    const use = svg.querySelector("use") as Element;
    expect(use.namespaceURI).toBe(SVG_NS);
    expect(use.getAttribute("href")).toBe("#icon");
    expect(use.getAttributeNS(XLINK_NS, "href")).toBeNull();
  });
});
