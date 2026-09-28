/**
 * Raw-text and RCDATA contexts — the places where the HTML parser stops
 * treating `<` as markup and where ordinary escaping rules change.
 *
 *   code text   <script>, <style>          text IS a program; never interpolated,
 *                                          never serialized by SSR
 *   RCDATA      <textarea>, <title>        entities decoded, tags are text
 *   RAWTEXT     <xmp>, <iframe>, <noembed>, entities NOT decoded, tags are text
 *               <noframes>, <noscript>*    (*when scripting is enabled)
 *
 * Client-side, SibuJS never parses: `html``` and the tag factories build text
 * with `createTextNode`, so no string can close its element. Server-side the
 * serializer escapes `<` in every text node, so no string can either — but
 * that is a property of the OUTPUT, so it is asserted here by parsing the
 * output with a real HTML parser and inspecting the resulting DOM, not by
 * searching strings.
 */

import { describe, expect, it } from "vitest";
import { html } from "../src/core/rendering/htm";
import { div, textarea, title } from "../src/core/rendering/html";
import { collectStream, renderToDocument, renderToStream, renderToString, serializeState } from "../src/platform/ssr";

const BREAKOUTS = [
  "</script><script>window.__pwned=1</script>",
  "</style><script>window.__pwned=1</script>",
  "</textarea><img src=x onerror=window.__pwned=1>",
  "</title><img src=x onerror=window.__pwned=1>",
  "</noscript><img src=x onerror=window.__pwned=1>",
  "</xmp><img src=x onerror=window.__pwned=1>",
  "</iframe><img src=x onerror=window.__pwned=1>",
  "</noembed><img src=x onerror=window.__pwned=1>",
  "</noframes><img src=x onerror=window.__pwned=1>",
  "<!--<script>window.__pwned=1</script>-->",
  "--><img src=x onerror=window.__pwned=1>",
  "--!><img src=x onerror=window.__pwned=1>",
  "<![CDATA[<img src=x onerror=window.__pwned=1>]]>",
  "&lt;/textarea&gt;<img src=x onerror=window.__pwned=1>",
];

const CONTAINERS = ["textarea", "title", "noscript", "xmp", "noembed", "noframes", "iframe", "div", "p", "option"];

/** Parse server output the way a browser would and report what became markup. */
function injected(markup: string): string[] {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${markup}`, "text/html");
  return Array.from(doc.querySelectorAll("script, img, [onerror], [onload]")).map((e) => e.outerHTML);
}

describe("client: interpolation into raw-text elements", () => {
  it("refuses ${…} inside the code-text elements <script> and <style>", () => {
    expect(() => html`<script>${"x"}</script>`).toThrow(/raw-text context/);
    expect(() => html`<style>${"x"}</style>`).toThrow(/raw-text context/);
    expect(() => html`<SCRIPT>${"x"}</SCRIPT>`).toThrow(/raw-text context/);
    expect(() => html`<svg><style>${"x"}</style></svg>`).toThrow(/raw-text context/);
  });

  for (const tag of ["textarea", "title", "noscript", "xmp", "noembed", "noframes"]) {
    it(`<${tag}>\${…} is a text node, never markup`, () => {
      for (const payload of BREAKOUTS) {
        const el = html([`<${tag}>`, `</${tag}>`] as unknown as TemplateStringsArray, payload);
        expect(el.children.length).toBe(0);
        expect(el.textContent).toBe(payload);
      }
    });
  }

  it("tag-factory text children are text too", () => {
    for (const payload of BREAKOUTS) {
      expect(textarea(payload).children.length).toBe(0);
      expect(title(payload).textContent).toBe(payload);
    }
  });
});

describe("SSR: text in every raw-text / RCDATA container cannot close it", () => {
  for (const tag of CONTAINERS) {
    it(`<${tag}> — string and stream renderers`, async () => {
      for (const payload of BREAKOUTS) {
        const el = document.createElement(tag);
        el.appendChild(document.createTextNode(payload));
        const wrapper = div([el]);
        const string = renderToString(wrapper);
        const stream = await collectStream(renderToStream(wrapper));
        expect(stream).toBe(string);
        expect(injected(string), `${tag} ← ${payload}`).toEqual([]);
      }
    });
  }

  it("RCDATA round-trips the exact text (escaping matches the context)", () => {
    for (const tag of ["textarea", "title"]) {
      for (const payload of BREAKOUTS) {
        const el = document.createElement(tag);
        el.textContent = payload;
        const doc = new DOMParser().parseFromString(`<body>${renderToString(div([el]))}`, "text/html");
        expect(doc.querySelector(tag)?.textContent).toBe(payload);
      }
    }
  });

  it("code-text elements are never serialized, whatever they contain", () => {
    for (const tag of ["script", "style"]) {
      const el = document.createElement(tag);
      el.textContent = "</script><script>window.__pwned=1</script>";
      const out = renderToString(div([el]));
      expect(out).not.toContain(`<${tag}`);
      expect(injected(out)).toEqual([]);
    }
  });

  it("comments cannot be terminated early", () => {
    for (const payload of BREAKOUTS) {
      const out = renderToString(div([document.createComment(payload)]));
      expect(injected(out), payload).toEqual([]);
    }
  });

  it("attribute values cannot break out of their quotes", () => {
    for (const payload of [
      '"><img src=x onerror=window.__pwned=1>',
      "'><img src=x onerror=window.__pwned=1>",
      ...BREAKOUTS,
    ]) {
      const out = renderToString(div({ title: payload, "data-x": payload }));
      expect(injected(out), payload).toEqual([]);
      const doc = new DOMParser().parseFromString(`<body>${out}`, "text/html");
      expect(doc.querySelector("div")?.getAttribute("title")).toBe(payload);
    }
  });

  it("document title, and serialized state, cannot break out either", () => {
    for (const payload of BREAKOUTS) {
      const page = renderToDocument(() => div("app"), { title: payload });
      const doc = new DOMParser().parseFromString(page, "text/html");
      expect(doc.title).toBe(payload);
      expect(doc.querySelectorAll("script, img").length, payload).toBe(0);

      const state = serializeState({ payload, "</script>": payload });
      const stateDoc = new DOMParser().parseFromString(`<body>${state}`, "text/html");
      const scripts = stateDoc.querySelectorAll("script");
      expect(scripts.length).toBe(1);
      expect(stateDoc.querySelectorAll("img").length).toBe(0);
      const json = (scripts[0].textContent ?? "").replace(/^window\.__SIBU_SSR_DATA__=/, "");
      expect(JSON.parse(json)).toEqual({ payload, "</script>": payload });
    }
  });
});
