/**
 * `renderToString` / `renderToStream` serialize SVG and MathML subtrees.
 *
 * They used to emit a foreign element as its escaped text content, so an icon
 * built with `svg()` / `path()` vanished from the server HTML until hydration
 * rebuilt it. The serializer is now namespace-aware:
 *
 *   - tag and attribute names keep their case (`viewBox`, `linearGradient`,
 *     `preserveAspectRatio`) and namespaced attributes keep their prefix
 *     (`xlink:href`), so the HTML parser rebuilds the same tree;
 *   - an empty foreign element self-closes (`<path … />`), which the HTML
 *     parser honours in foreign content; HTML void rules are unchanged;
 *   - the runtime policy applies: `on*` dropped, URL attributes through the
 *     allowlist, an animation may not target a URL or handler attribute,
 *     `<script>` / `<style>` stripped, `<foreignObject>` content serialized by
 *     the HTML rules;
 *   - every element carries the `data-sibu-ssr` provenance marker.
 */

import { describe, expect, it } from "vitest";
import { div, g, linearGradient, path, stop, svg, use } from "../src/core/rendering/html";
import { svgElement } from "../src/platform/customElement";
import { collectStream, renderToStream, renderToString } from "../src/platform/ssr";

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/** Serialize with both renderers, assert they agree, and return the string. */
async function render(node: Node): Promise<string> {
  const string = renderToString(node);
  expect(await collectStream(renderToStream(node))).toBe(string);
  return string;
}

/** Parse server output the way a browser would, inside a `<body>`. */
function parse(markup: string): HTMLElement {
  return new DOMParser().parseFromString(`<!doctype html><body>${markup}`, "text/html").body;
}

/** A namespace-aware structural description of a subtree, markers excluded. */
function shape(node: Node): unknown {
  if (node.nodeType === 3) return node.nodeValue;
  if (node.nodeType !== 1) return null;
  const el = node as Element;
  const attrs = Array.from(el.attributes)
    .filter((a) => a.name !== "data-sibu-ssr")
    .map((a) => `${a.namespaceURI ?? ""}|${a.localName}=${a.value}`)
    .sort();
  return {
    ns: el.namespaceURI,
    name: el.localName,
    attrs,
    children: Array.from(el.childNodes)
      .map(shape)
      .filter((c) => c !== null),
  };
}

describe("renderToString — SVG", () => {
  it("serializes an icon built with the tag factories", async () => {
    const out = await render(div([svg({ viewBox: "0 0 24 24" }, [path({ d: "M4 12h16" })])]));
    expect(out).toBe(
      '<div data-sibu-ssr="true"><svg viewBox="0 0 24 24" data-sibu-ssr="true">' +
        '<path d="M4 12h16" data-sibu-ssr="true" /></svg></div>',
    );
  });

  it("keeps the case of camelCase tags and attributes", async () => {
    const icon = svg({ viewBox: "0 0 10 10", preserveAspectRatio: "xMidYMid meet" }, [
      linearGradient({ id: "grad", gradientUnits: "userSpaceOnUse" }, [stop({ offset: "0", "stop-color": "red" })]),
      g({ "stroke-linecap": "round", "stroke-linejoin": "round" }, [g([path({ d: "M0 0L10 10" })])]),
    ]);
    const out = await render(icon);
    for (const needle of [
      'viewBox="0 0 10 10"',
      'preserveAspectRatio="xMidYMid meet"',
      "<linearGradient ",
      "</linearGradient>",
      'gradientUnits="userSpaceOnUse"',
      'stroke-linecap="round"',
      'stop-color="red"',
    ]) {
      expect(out, needle).toContain(needle);
    }
    // Nested groups survive with their children.
    expect(out).toContain('<g data-sibu-ssr="true"><path d="M0 0L10 10" data-sibu-ssr="true" /></g>');
  });

  it("round-trips: the parsed output equals the original tree", async () => {
    const icon = svg({ viewBox: "0 0 24 24", fill: "none" }, [
      linearGradient({ id: "g1" }, [stop({ offset: "1" })]),
      g({ transform: "translate(1 1)" }, [path({ d: "M4 12h16" }), path({ d: "M12 4v16" })]),
      use({ href: "#g1" }),
    ]);
    const tree = div({ class: "icon" }, [icon, "label"]);
    const parsed = parse(await render(tree)).firstElementChild as Element;
    expect(shape(parsed)).toEqual(shape(tree));
  });

  it('keeps xlink:href on <use href="#id"> in the xlink namespace', async () => {
    const icon = svgElement("svg", {}, svgElement("use", { "xlink:href": "#icon" }));
    const out = await render(icon);
    expect(out).toContain('xlink:href="#icon"');
    const parsedUse = parse(out).querySelector("use") as Element;
    expect(parsedUse.getAttributeNS(XLINK_NS, "href")).toBe("#icon");
  });

  it("writes an attribute set through setAttributeNS with its conventional prefix", async () => {
    const root = document.createElementNS(SVG_NS, "svg");
    const u = document.createElementNS(SVG_NS, "use");
    // No prefix supplied: the attribute's qualified name is just `href`.
    u.setAttributeNS(XLINK_NS, "href", "#a");
    root.appendChild(u);
    const out = await render(root);
    expect(out).toContain('xlink:href="#a"');
    expect(parse(out).querySelector("use")?.getAttributeNS(XLINK_NS, "href")).toBe("#a");
  });

  it("drops a hostile <a href> inside SVG but keeps the link element", async () => {
    // Raw DOM: the framework's writers would refuse this value outright, so it
    // stands in for markup built by a third-party library.
    const root = document.createElementNS(SVG_NS, "svg");
    const a = document.createElementNS(SVG_NS, "a");
    a.setAttribute("href", "javascript:alert(1)");
    a.setAttributeNS(XLINK_NS, "xlink:href", "javascript:alert(2)");
    a.appendChild(document.createElementNS(SVG_NS, "circle"));
    root.appendChild(a);
    const image = document.createElementNS(SVG_NS, "image");
    image.setAttribute("href", "data:image/svg+xml,<svg onload=alert(3)>");
    root.appendChild(image);
    const out = await render(root);
    expect(out).toContain("<a ");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("data:");
    expect(out).toBe(
      '<svg data-sibu-ssr="true"><a data-sibu-ssr="true"><circle data-sibu-ssr="true" /></a>' +
        '<image data-sibu-ssr="true" /></svg>',
    );
  });

  it("refuses an animation aimed at a URL or handler attribute", async () => {
    const root = document.createElementNS(SVG_NS, "svg");
    const a = document.createElementNS(SVG_NS, "a");
    root.appendChild(a);
    for (const [tag, target] of [
      ["animate", "href"],
      ["set", "xlink:href"],
      ["set", "onclick"],
      ["animate", " HREF"],
    ] as const) {
      const anim = document.createElementNS(SVG_NS, tag);
      anim.setAttribute("attributeName", target);
      anim.setAttribute("to", "javascript:alert(1)");
      a.appendChild(anim);
    }
    // An animation of an inert attribute keeps its target.
    const fine = document.createElementNS(SVG_NS, "animate");
    fine.setAttribute("attributeName", "opacity");
    fine.setAttribute("to", "0");
    root.appendChild(fine);

    const out = await render(root);
    expect(out.match(/attributeName=/g)).toHaveLength(1);
    expect(out).toContain('attributeName="opacity"');
    const doc = parse(out);
    for (const anim of Array.from(doc.querySelectorAll("a animate, a set"))) {
      expect(anim.hasAttribute("attributeName")).toBe(false);
    }
  });

  it("drops on* attributes and strips SVG <script> / <style>", async () => {
    const root = document.createElementNS(SVG_NS, "svg");
    root.setAttribute("onload", "alert(1)");
    const script = document.createElementNS(SVG_NS, "script");
    script.textContent = "alert(2)";
    root.appendChild(script);
    const style = document.createElementNS(SVG_NS, "style");
    style.textContent = "@import url(https://attacker.example/x.css);";
    root.appendChild(style);
    const out = await render(root);
    expect(out).not.toContain("onload");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("attacker");
    expect(parse(out).querySelectorAll("script, style")).toHaveLength(0);
  });

  it("serializes <foreignObject> content under the HTML rules", async () => {
    const root = document.createElementNS(SVG_NS, "svg");
    const fo = document.createElementNS(SVG_NS, "foreignObject");
    fo.setAttribute("width", "10");
    const p = document.createElement("p");
    p.textContent = "<b>&</b>";
    const img = document.createElement("img");
    img.setAttribute("src", "javascript:alert(1)");
    img.setAttribute("alt", "x");
    const script = document.createElement("script");
    script.textContent = "alert(1)";
    fo.append(p, img, script);
    root.appendChild(fo);
    const out = await render(root);
    expect(out).toContain("<foreignObject ");
    expect(out).toContain('<p data-sibu-ssr="true">&lt;b&gt;&amp;&lt;/b&gt;</p>');
    expect(out).toContain('<img alt="x" data-sibu-ssr="true" />');
    expect(out).not.toContain("<script");
    const parsedP = parse(out).querySelector("foreignObject p") as Element;
    expect(parsedP.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
  });

  it("escapes SVG text and attribute values", async () => {
    const root = svg({ "aria-label": `"><script>x</script>` }, [
      svgElement("text", {}, `a < b & "c"`) as unknown as SVGElement,
    ]);
    const out = await render(root);
    expect(out).toContain('aria-label="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
    expect(out).toContain(`a &lt; b &amp; "c"</text>`);
    expect(parse(out).querySelectorAll("script")).toHaveLength(0);
  });
});

describe("renderToString — MathML", () => {
  it("serializes a MathML subtree in its own namespace", async () => {
    const math = document.createElementNS(MATHML_NS, "math");
    math.setAttribute("display", "block");
    const mi = document.createElementNS(MATHML_NS, "mi");
    mi.textContent = "x";
    const mspace = document.createElementNS(MATHML_NS, "mspace");
    mspace.setAttribute("width", "1em");
    math.append(mi, mspace);
    const tree = div([math]);
    const out = await render(tree);
    expect(out).toBe(
      '<div data-sibu-ssr="true"><math display="block" data-sibu-ssr="true">' +
        '<mi data-sibu-ssr="true">x</mi><mspace width="1em" data-sibu-ssr="true" /></math></div>',
    );
    const parsed = parse(out).firstElementChild as Element;
    expect(shape(parsed)).toEqual(shape(tree));
  });

  it("applies the URL allowlist to a MathML href", async () => {
    const math = document.createElementNS(MATHML_NS, "math");
    const mi = document.createElementNS(MATHML_NS, "mi");
    mi.setAttribute("href", "javascript:alert(1)");
    mi.textContent = "x";
    math.appendChild(mi);
    const out = await render(math);
    expect(out).not.toContain("javascript:");
    expect(out).toContain("<mi ");
  });
});
