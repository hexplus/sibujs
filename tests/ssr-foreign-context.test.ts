/**
 * SSR emits a foreign (SVG / MathML) element only where the HTML parser will
 * rebuild it in the same namespace — and an HTML element inside foreign
 * content only where the parser will rebuild it as HTML.
 *
 * The HTML parser does not trust the serializer's namespaces. Outside an
 * `<svg>` / `<math>` root, `<link>`, `<meta>`, `<base>` … are HTML elements; and
 * inside foreign content a start tag such as `<p>`, `<div>`, `<meta>` or `<img>`
 * "breaks out" — the parser closes the foreign elements and continues as HTML,
 * so every following sibling is parsed as HTML too.
 *
 * An SVG-namespace `<link rel=stylesheet>` or `<meta http-equiv=refresh>` is
 * inert in the client DOM, so the client writers do not apply the HTML
 * contextual rules to it. Serialized as text and parsed as HTML it became a
 * live stylesheet or redirect. Such elements are now stripped:
 *
 *   - a foreign element other than an `<svg>` / `<math>` root, outside a
 *     foreign parent of its own namespace, or under an integration point
 *     (`foreignObject`, `desc`, `title`; MathML text integration points and
 *     `annotation-xml`);
 *   - a foreign element whose name is an HTML breakout tag;
 *   - an HTML element directly inside foreign content that is not an
 *     integration point.
 */

import { describe, expect, it } from "vitest";
import { div, path, svg } from "../src/core/rendering/html";
import { svgElement } from "../src/platform/customElement";
import { collectStream, renderToStream, renderToString } from "../src/platform/ssr";

const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const HTML_NS = "http://www.w3.org/1999/xhtml";

async function render(node: Node): Promise<string> {
  const string = renderToString(node);
  expect(await collectStream(renderToStream(node))).toBe(string);
  return string;
}

function parse(markup: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${markup}`, "text/html");
}

/** Every element of the parsed document whose namespace is HTML and whose name is one of `names`. */
function htmlElements(doc: Document, names: string[]): Element[] {
  return Array.from(doc.querySelectorAll("*")).filter((e) => e.namespaceURI === HTML_NS && names.includes(e.localName));
}

const SENSITIVE = ["link", "meta", "base", "iframe", "form", "img", "object", "embed", "style", "script"];

describe("foreign elements outside foreign content", () => {
  it("strips an SVG <link> / <meta> / <base> written at HTML level", async () => {
    const tree = div([
      svgElement("link", { rel: "stylesheet", href: "https://evil.example/x.css" }) as unknown as Node,
      svgElement("meta", { "http-equiv": "refresh", content: "0;url=https://evil.example/" }) as unknown as Node,
      svgElement("base", { href: "https://evil.example/" }) as unknown as Node,
    ]);
    const out = await render(tree);
    expect(htmlElements(parse(out), SENSITIVE)).toEqual([]);
    expect(out).not.toContain("evil.example");
  });

  it("strips a non-root SVG element given straight to renderToString", async () => {
    expect(await render(path({ d: "M0 0" }))).not.toContain("<path");
  });

  it("still emits <svg> and <math> roots at HTML level", async () => {
    const math = document.createElementNS(MATHML_NS, "math");
    math.appendChild(document.createElementNS(MATHML_NS, "mi")).textContent = "x";
    const out = await render(div([svg([path({ d: "M0 0" })]), math]));
    const doc = parse(out);
    expect(doc.querySelector("svg")?.namespaceURI).toBe(SVG_NS);
    expect(doc.querySelector("path")?.namespaceURI).toBe(SVG_NS);
    expect(doc.querySelector("math")?.namespaceURI).toBe(MATHML_NS);
    expect(doc.querySelector("mi")?.namespaceURI).toBe(MATHML_NS);
  });
});

describe("breakout tags inside foreign content", () => {
  it("strips an SVG element named like an HTML breakout tag, so following siblings stay SVG", async () => {
    const root = document.createElementNS(SVG_NS, "svg");
    root.appendChild(document.createElementNS(SVG_NS, "p"));
    const meta = document.createElementNS(SVG_NS, "meta");
    meta.setAttribute("http-equiv", "refresh");
    meta.setAttribute("content", "0;url=https://evil.example/");
    root.appendChild(meta);
    const link = document.createElementNS(SVG_NS, "link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", "https://evil.example/x.css");
    root.appendChild(link);
    const out = await render(div([root]));
    const doc = parse(out);
    expect(htmlElements(doc, SENSITIVE)).toEqual([]);
    // The non-breakout `link` stays in the SVG namespace, where it is inert.
    expect(doc.querySelector("svg link")?.namespaceURI).toBe(SVG_NS);
    expect(out).not.toContain("refresh");
  });

  it("strips an HTML element placed directly in SVG, so following siblings stay SVG", async () => {
    const root = document.createElementNS(SVG_NS, "svg");
    root.appendChild(document.createElement("div"));
    const link = document.createElementNS(SVG_NS, "link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", "https://evil.example/x.css");
    root.appendChild(link);
    const out = await render(root);
    const doc = parse(out);
    expect(htmlElements(doc, SENSITIVE)).toEqual([]);
    expect(htmlElements(doc, ["div"])).toEqual([]);
    expect(doc.querySelector("svg link")?.namespaceURI).toBe(SVG_NS);
  });

  it("keeps HTML inside the integration points", async () => {
    const root = document.createElementNS(SVG_NS, "svg");
    const fo = root.appendChild(document.createElementNS(SVG_NS, "foreignObject"));
    fo.appendChild(document.createElement("p")).textContent = "in fo";
    const desc = root.appendChild(document.createElementNS(SVG_NS, "desc"));
    desc.appendChild(document.createElement("b")).textContent = "in desc";
    const math = document.createElementNS(MATHML_NS, "math");
    const mtext = math.appendChild(document.createElementNS(MATHML_NS, "mtext"));
    mtext.appendChild(document.createElement("span")).textContent = "in mtext";
    const doc = parse(await render(div([root, math])));
    expect(doc.querySelector("foreignObject > p")?.namespaceURI).toBe(HTML_NS);
    expect(doc.querySelector("desc > b")?.namespaceURI).toBe(HTML_NS);
    expect(doc.querySelector("mtext > span")?.namespaceURI).toBe(HTML_NS);
  });

  it("strips SVG elements placed under an integration point, where they would parse as HTML", async () => {
    const root = document.createElementNS(SVG_NS, "svg");
    const fo = root.appendChild(document.createElementNS(SVG_NS, "foreignObject"));
    const link = fo.appendChild(document.createElementNS(SVG_NS, "link"));
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", "https://evil.example/x.css");
    // A nested <svg> root under foreignObject is fine: the parser re-enters SVG.
    fo.appendChild(document.createElementNS(SVG_NS, "svg")).appendChild(document.createElementNS(SVG_NS, "circle"));
    const doc = parse(await render(root));
    expect(htmlElements(doc, SENSITIVE)).toEqual([]);
    expect(doc.querySelector("foreignObject svg circle")?.namespaceURI).toBe(SVG_NS);
  });

  it("round-trips xml: and xmlns: attributes into their namespaces", async () => {
    const XML_NS = "http://www.w3.org/XML/1998/namespace";
    const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
    const XLINK_NS = "http://www.w3.org/1999/xlink";
    const root = document.createElementNS(SVG_NS, "svg");
    root.setAttributeNS(XMLNS_NS, "xmlns:xlink", XLINK_NS);
    const text = root.appendChild(document.createElementNS(SVG_NS, "text"));
    text.setAttributeNS(XML_NS, "space", "preserve");
    text.textContent = "  a  ";
    const parsed = parse(await render(root));
    expect(parsed.querySelector("svg")?.getAttributeNS(XMLNS_NS, "xlink")).toBe(XLINK_NS);
    expect(parsed.querySelector("text")?.getAttributeNS(XML_NS, "space")).toBe("preserve");
    expect(parsed.querySelector("text")?.textContent).toBe("  a  ");
  });

  it("round-trips nested foreign content structurally", async () => {
    const root = document.createElementNS(SVG_NS, "svg");
    root.setAttribute("viewBox", "0 0 10 10");
    const g = root.appendChild(document.createElementNS(SVG_NS, "g"));
    g.appendChild(document.createElementNS(SVG_NS, "clipPath")).appendChild(document.createElementNS(SVG_NS, "rect"));
    const fo = g.appendChild(document.createElementNS(SVG_NS, "foreignObject"));
    const math = fo.appendChild(document.createElementNS(MATHML_NS, "math"));
    math.appendChild(document.createElementNS(MATHML_NS, "mi")).textContent = "a < b & c";
    const doc = parse(await render(root));
    const shape = (n: Element): unknown => ({
      ns: n.namespaceURI,
      name: n.localName,
      children: Array.from(n.children).map(shape),
    });
    expect(shape(doc.querySelector("svg") as Element)).toEqual(shape(root));
    expect(doc.querySelector("mi")?.textContent).toBe("a < b & c");
  });
});
