/**
 * What "SVG is serialized as text only" means for SSR — pinned.
 *
 * `renderToString` / `renderToStream` serialize HTML elements. A non-HTML
 * element (SVG, MathML) is emitted as its escaped TEXT CONTENT: no tag, no
 * attribute, no namespace. That is an implementation limitation — the graphic
 * is missing from the server HTML until hydration replaces the tree — and this
 * file proves it is not a security one:
 *
 *   - nothing SVG-specific can reach the output: no `href` / `xlink:href`, no
 *     `attributeName`, no `style`, no `on*`, no `<script>` or `<style>` element;
 *   - the text that is emitted is escaped, so `<`, `>` and `&` in SVG text
 *     cannot become markup;
 *   - string and stream renderers agree byte for byte;
 *   - hydration rebuilds real SVG in the SVG namespace, with the client policy
 *     applied — the server's text never survives into the live tree.
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
  // Foreign DOM the framework never vetted: a live SVG script and style.
  const script = document.createElementNS(SVG_NS, "script");
  script.textContent = "alert('svg script')";
  script.setAttributeNS(XLINK_NS, "xlink:href", "javascript:alert(1)");
  root.appendChild(script);
  const style = document.createElementNS(SVG_NS, "style");
  style.textContent = "@import url(https://attacker.example/x.css);";
  root.appendChild(style);
  const set = document.createElementNS(SVG_NS, "set");
  set.setAttribute("attributeName", "href");
  set.setAttribute("to", "javascript:alert(1)");
  a.appendChild(set);
  return root;
}

function injected(markup: string): string[] {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${markup}`, "text/html");
  return Array.from(doc.querySelectorAll("svg, script, style, img, [onerror], [onload], [href], set, animate")).map(
    (e) => e.outerHTML,
  );
}

describe("SVG SSR — text only, and nothing security-sensitive", () => {
  it("emits no SVG element, attribute or namespace; string and stream agree", async () => {
    const tree = div([hostileSvg()]);
    const string = renderToString(tree);
    expect(await collectStream(renderToStream(tree))).toBe(string);
    expect(injected(string)).toEqual([]);
    // `attacker.example` may appear, but only as escaped TEXT (the SVG
    // <style> body) — `injected()` above proves no element carries it.
    for (const needle of ["<svg", "href", "attributeName", "onload", "javascript:", "xlink"]) {
      expect(string, needle).not.toContain(needle);
    }
  });

  it("escapes the SVG text it does emit", () => {
    const out = renderToString(div([hostileSvg()]));
    expect(out).toContain("Label &lt;b&gt;&amp;amp;&lt;/b&gt;");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // Script and style bodies become inert text in the HTML document.
    const doc = new DOMParser().parseFromString(`<body>${out}`, "text/html");
    expect(doc.querySelectorAll("script, style").length).toBe(0);
  });

  it("html`` SVG takes the same path", async () => {
    const tree = html`<div><svg viewBox="0 0 1 1"><circle r="1" style="fill:red"></circle><text>t</text></svg></div>`;
    const string = renderToString(tree);
    expect(await collectStream(renderToStream(tree))).toBe(string);
    expect(injected(string)).toEqual([]);
    expect(string).toContain("t");
  });

  it("hydration rebuilds real SVG in the SVG namespace, under the client policy", () => {
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
    expect(container.querySelector("svg")).toBeNull();
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
