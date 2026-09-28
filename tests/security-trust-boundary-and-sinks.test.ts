/**
 * Regression suite for the second security review of the contextual policy.
 *
 *   1. `preloadImage()` / `imageLoader()` committed runtime URLs to `Image.src`
 *      without the canonical URL policy every other sink applies.
 *   2. Reactive `<meta>` ownership: only a live binding on the refresh-relevant
 *      attributes (`http-equiv`, `content`) may claim an element. An unrelated
 *      live attribute no longer withdraws a static, approved directive.
 *   3. The static-vs-runtime trust boundary of `html```, asserted directly.
 *   4. Static `srcdoc` was kept by the client and dropped by every SSR
 *      serializer — the only place where static trust contradicted the
 *      documented "refused on every path" rule.
 *
 * Every assertion is a POSTCONDITION on what reaches the DOM, the server HTML,
 * or the image request — never on which helper was called.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageLoader } from "../src/browser/imageLoader";
import { planHtmlTemplates } from "../src/build/templateCompiler";
import { html } from "../src/core/rendering/htm";
import { a, button, meta } from "../src/core/rendering/html";
import { SVG_NS, tagFactory } from "../src/core/rendering/tagFactory";
import { signal } from "../src/core/signals/signal";
import { preloadImage } from "../src/performance/domRecycler";
import { svgElement } from "../src/platform/customElement";
import { collectStream, renderToStream, renderToString } from "../src/platform/ssr";
import { bindAttribute, bindDynamic } from "../src/reactivity/bindAttribute";
import { bindAttrs } from "../src/ui/reactiveAttr";
import { type MetaRefreshDecision, resolveMetaRefreshPolicy } from "../src/utils/metaRefresh";

const XLINK_NS = "http://www.w3.org/1999/xlink";

// ─── 1. image URL sinks ─────────────────────────────────────────────────────

/** Every `Image` constructed, and every `src` it was given — no network. */
const images: { src: string[]; onload: (() => void) | null; onerror: ((e: unknown) => void) | null }[] = [];
const RealImage = globalThis.Image;

class StubImage {
  onload: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  naturalWidth = 3;
  naturalHeight = 2;
  private record: (typeof images)[number];
  constructor() {
    this.record = { src: [], onload: null, onerror: null };
    images.push(this.record);
  }
  set src(value: string) {
    this.record.src.push(value);
    this.record.onload = this.onload;
    this.record.onerror = this.onerror;
    // Every accepted source "loads" on the next microtask; a `/broken…` one fails.
    if (value.includes("/broken")) queueMicrotask(() => this.onerror?.(new Event("error")));
    else if (value !== "") queueMicrotask(() => this.onload?.());
  }
}

const ALLOWED_IMAGE_URLS = [
  "/image.png",
  "./image.png",
  "../image.png",
  "image.png?v=2#x",
  "https://example.com/image.png",
  "http://example.com/image.png",
  "//cdn.example.com/image.png",
  "ftp://files.example.com/image.png",
];

const REFUSED_IMAGE_URLS = [
  "javascript:alert(1)",
  "JAVASCRIPT:alert(1)",
  "JaVaScRiPt:alert(1)",
  " javascript:alert(1)",
  "\tjavascript:alert(1)",
  "\u0001javascript:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "java\rscript:alert(1)",
  "javascript:\nalert(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:image/svg+xml,<svg onload=alert(1)>",
  "vbscript:msgbox(1)",
  "blob:https://example.com/0f6c",
  "file:///etc/passwd",
  "\\\\attacker.example\\share\\x.png",
];

describe("preloadImage() applies the canonical URL policy", () => {
  beforeEach(() => {
    images.length = 0;
    (globalThis as { Image: unknown }).Image = StubImage;
  });
  afterEach(() => {
    (globalThis as { Image: unknown }).Image = RealImage;
  });

  for (const url of ALLOWED_IMAGE_URLS) {
    it(`loads ${JSON.stringify(url)} exactly as given`, async () => {
      const img = await preloadImage(url);
      expect(img).toBeInstanceOf(StubImage);
      expect(images.map((i) => i.src)).toEqual([[url]]);
    });
  }

  for (const url of REFUSED_IMAGE_URLS) {
    it(`PoC: refuses ${JSON.stringify(url)} — rejects, creates no Image, requests nothing`, async () => {
      await expect(preloadImage(url)).rejects.toThrow("preloadImage: refusing an image URL outside the URL policy.");
      expect(images).toEqual([]);
    });
  }

  it("rejects an empty URL deterministically, as a missing URL rather than a policy refusal", async () => {
    for (const url of ["", "   "]) {
      await expect(preloadImage(url)).rejects.toThrow("preloadImage: no image URL was given.");
    }
    expect(images).toEqual([]);
  });

  it("the error does not echo the refused URL", async () => {
    const secret = "javascript:fetch('/token?session=abc123')";
    await expect(preloadImage(secret)).rejects.toSatisfy((e: Error) => !e.message.includes("abc123"));
  });

  it("a load failure of an ALLOWED URL still rejects, with the browser's error event", async () => {
    await expect(preloadImage("/broken.png")).rejects.toBeInstanceOf(Event);
    expect(images.map((i) => i.src)).toEqual([["/broken.png"]]);
  });
});

describe("imageLoader() — the sibling sink — applies the same policy", () => {
  beforeEach(() => {
    images.length = 0;
    (globalThis as { Image: unknown }).Image = StubImage;
  });
  afterEach(() => {
    (globalThis as { Image: unknown }).Image = RealImage;
  });

  for (const url of REFUSED_IMAGE_URLS) {
    it(`PoC: refuses ${JSON.stringify(url)} — status error, no request`, () => {
      const state = imageLoader(url);
      expect(state.status()).toBe("error");
      expect(images).toEqual([]);
      state.dispose();
    });
  }

  it("a reactive source switching to a refused URL never requests it", async () => {
    const [src, setSrc] = signal("/ok.png");
    const state = imageLoader(() => src());
    await Promise.resolve();
    expect(state.status()).toBe("loaded");
    setSrc("javascript:alert(1)");
    expect(state.status()).toBe("error");
    expect(state.image()).toBeNull();
    expect(images.flatMap((i) => i.src)).toEqual(["/ok.png"]);
    setSrc("/next.png");
    await Promise.resolve();
    expect(state.status()).toBe("loaded");
    state.dispose();
  });

  it("allowed URLs load unchanged", async () => {
    const state = imageLoader("https://example.com/a.png");
    await Promise.resolve();
    expect(state.status()).toBe("loaded");
    expect(state.width()).toBe(3);
    expect(images.map((i) => i.src)).toEqual([["https://example.com/a.png"]]);
    state.dispose();
  });
});

// ─── 2. reactive <meta> ownership ───────────────────────────────────────────

function verdict(el: Element): MetaRefreshDecision["kind"] {
  const map = new Map<string, string>();
  for (const attr of Array.from(el.attributes)) map.set(attr.name, attr.value);
  return resolveMetaRefreshPolicy(map).kind;
}

describe("reactive <meta> — ownership follows the refresh-relevant attributes only", () => {
  afterEach(() => {
    for (const m of Array.from(document.head.querySelectorAll("meta"))) m.remove();
  });

  it("static safe refresh is published; static forbidden refresh is refused", () => {
    expect(verdict(html`<meta http-equiv="refresh" content="5;url=/safe">`)).toBe("allowed");
    expect(verdict(meta({ "http-equiv": "refresh", content: "5;url=/safe" }))).toBe("allowed");
    expect(verdict(html`<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`)).not.toBe("forbidden");
    expect(verdict(meta({ "http-equiv": "refresh", content: "0;url=javascript:alert(1)" }))).not.toBe("forbidden");
  });

  it("PoC: a static directive beside a reactive data-* attribute is KEPT, and the live attribute works", () => {
    const [state, setState] = signal("idle");
    const el = html`<meta http-equiv="refresh" content="5;url=/safe" data-state=${() => state()}>`;
    document.head.appendChild(el);
    expect(el.getAttribute("content")).toBe("5;url=/safe");
    setState("busy");
    expect(el.getAttribute("data-state")).toBe("busy");
    expect(verdict(el)).toBe("allowed");

    const viaProps = meta({ "http-equiv": "refresh", content: "5;url=/safe", name: () => state() });
    expect(verdict(viaProps)).toBe("allowed");
  });

  interface Case {
    label: string;
    run(el: HTMLMetaElement): void;
  }
  const flips: Case[] = [
    {
      label: "reactive content, safe → unsafe",
      run(el) {
        const [c, setC] = signal("5;url=/safe");
        bindAttrs(el, { "http-equiv": "refresh" });
        bindAttribute(el, "content", () => c());
        setC("0;url=javascript:alert(1)");
      },
    },
    {
      label: "reactive content, unsafe → safe",
      run(el) {
        const [c, setC] = signal("0;url=javascript:alert(1)");
        bindAttrs(el, { "http-equiv": "refresh" });
        bindAttribute(el, "content", () => c());
        setC("5;url=/safe");
      },
    },
    {
      label: "reactive content, null → refresh",
      run(el) {
        const [c, setC] = signal<string | null>(null);
        bindAttribute(el, "content", () => c());
        bindAttrs(el, { "http-equiv": "refresh" });
        setC("5;url=/safe");
      },
    },
    {
      label: "reactive http-equiv, x-custom → refresh",
      run(el) {
        const [e, setE] = signal("x-custom");
        bindAttrs(el, { content: "5;url=/safe" });
        bindAttribute(el, "http-equiv", () => e());
        setE("refresh");
      },
    },
    {
      label: 'reactive http-equiv, → "\\u0001 REFRESH "',
      run(el) {
        const [e, setE] = signal("x-custom");
        bindAttrs(el, { content: "5;url=/safe" });
        bindAttribute(el, "HTTP-EQUIV", () => e());
        setE("\u0001 REFRESH ");
      },
    },
    {
      label: "bindDynamic name data-x → Content",
      run(el) {
        const [n, setN] = signal("data-x");
        bindAttrs(el, { "http-equiv": "refresh" });
        bindDynamic(el, () => n(), "5;url=/safe");
        setN("Content");
      },
    },
  ];

  for (const connected of [false, true]) {
    for (const c of flips) {
      it(`${c.label} (${connected ? "connected" : "detached"}) never holds a directive`, () => {
        const el = document.createElement("meta");
        if (connected) document.head.appendChild(el);
        c.run(el);
        expect(verdict(el)).toBe("not-refresh");
      });
    }
  }

  it("removal of a reactive content is committed", () => {
    const [c, setC] = signal<string | null>("description text");
    const el = meta({ name: "description", content: () => c() });
    setC(null);
    expect(el.hasAttribute("content")).toBe(false);
  });

  it("the verdict does not depend on attribute order or name casing", () => {
    const payloads = ["0;url=javascript:alert(1)", "0;url=data:text/html,x", "5;url=/safe"];
    for (const p of payloads) {
      const verdicts = [
        verdict(html`<meta content=${p} http-equiv="refresh">`),
        verdict(html`<meta http-equiv="refresh" content=${p}>`),
        verdict(html`<meta CONTENT=${p} HTTP-EQUIV="refresh">`),
        verdict(html`<meta Http-Equiv="REFRESH" Content=${p}>`),
        verdict(meta({ content: p, "http-equiv": "refresh" })),
        verdict(meta({ "HTTP-EQUIV": "refresh", Content: p })),
      ];
      expect(new Set(verdicts).size, `${p}: ${verdicts.join(",")}`).toBe(1);
      expect(verdicts[0]).not.toBe("forbidden");
    }
  });
});

// ─── 3. static vs runtime trust boundary ────────────────────────────────────

describe("html`` trust boundary — event handlers", () => {
  it("STATIC source is developer-authored markup: its onclick is kept", () => {
    const el = html`<button onclick="doSomething()">Test</button>`;
    expect(el.getAttribute("onclick")).toBe("doSomething()");
  });

  it("an INTERPOLATED onclick string is refused", () => {
    const value = "doSomething()";
    const el = html`<button onclick=${value}>Test</button>`;
    expect(el.hasAttribute("onclick")).toBe(false);
  });

  it("a MIXED onclick is runtime-derived as a whole and refused", () => {
    const value = "1";
    const el = html`<button onclick="foo(${value})">Test</button>`;
    expect(el.hasAttribute("onclick")).toBe(false);
    expect(html`<button ONCLICK="a${value}">x</button>`.hasAttribute("onclick")).toBe(false);
  });

  it("an interpolated on:event string attaches nothing and writes no attribute", () => {
    const el = html`<button on:click=${"alert(1)"}>x</button>`;
    expect(el.getAttributeNames()).toEqual([]);
  });

  it("tag factories never had a static domain: an onclick string prop is refused", () => {
    expect(button({ onclick: "doSomething()" }).hasAttribute("onclick")).toBe(false);
  });
});

describe("html`` trust boundary — URLs", () => {
  it("STATIC source keeps a developer-authored javascript: href", () => {
    expect(html`<a href="javascript:developerAuthored()">x</a>`.getAttribute("href")).toBe(
      "javascript:developerAuthored()",
    );
  });

  it("an INTERPOLATED javascript: href is omitted", () => {
    expect(html`<a href=${"javascript:alert(1)"}>x</a>`.hasAttribute("href")).toBe(false);
    expect(a({ href: "javascript:alert(1)" }).hasAttribute("href")).toBe(false);
  });

  it("split attacks are judged on the ASSEMBLED value, not per fragment", () => {
    for (const payload of ["script", "\tscript", "SCRIPT", "\nscript"]) {
      expect(html`<a href="java${payload}:alert(1)">x</a>`.hasAttribute("href"), payload).toBe(false);
    }
    // Each fragment alone looks harmless; together they are a scheme.
    const scheme = "javascript";
    expect(html`<a href="${scheme}:${"alert(1)"}">x</a>`.hasAttribute("href")).toBe(false);
    // …and a harmless assembly is kept verbatim.
    expect(html`<a href="/users/${"42"}/profile">x</a>`.getAttribute("href")).toBe("/users/42/profile");
  });
});

describe("SSR is conservative about static trust — documented, intentional", () => {
  // The serializer receives DOM, not template source, so it cannot know which
  // attributes were developer-authored. It applies the runtime value policy to
  // everything it emits; hydration then replaces the tree with the client's.
  it("drops a static onclick and a static javascript: href, identically when streaming", async () => {
    const el = html`<div><button onclick="doSomething()">t</button><a href="javascript:x()">l</a></div>`;
    const string = renderToString(el);
    expect(await collectStream(renderToStream(el))).toBe(string);
    expect(string).not.toContain("onclick");
    expect(string).not.toContain("javascript:");
  });
});

// ─── 4. srcdoc, static and runtime ──────────────────────────────────────────

describe("srcdoc is refused on every path, static source included", () => {
  it("PoC: a STATIC srcdoc in html`` is refused, matching SSR", async () => {
    const el = html`<iframe srcdoc="<script>parent.pwned=1</script>" title="t"></iframe>`;
    expect(el.hasAttribute("srcdoc")).toBe(false);
    expect(el.getAttribute("title")).toBe("t");
    const string = renderToString(el);
    expect(await collectStream(renderToStream(el))).toBe(string);
    expect(string).not.toContain("srcdoc");
  });

  it("any casing, boolean form, and runtime / reactive values are refused too", () => {
    expect(html`<iframe SrcDoc="<p>x</p>"></iframe>`.hasAttribute("srcdoc")).toBe(false);
    expect(html`<iframe srcdoc></iframe>`.hasAttribute("srcdoc")).toBe(false);
    expect(html`<iframe srcdoc=${"<p>x</p>"}></iframe>`.hasAttribute("srcdoc")).toBe(false);
    expect(html`<iframe srcdoc=${() => "<p>x</p>"}></iframe>`.hasAttribute("srcdoc")).toBe(false);
  });

  it("the template compiler leaves a static-srcdoc template to the runtime", () => {
    const code = [
      'import { html } from "sibujs";',
      'export const a = () => html`<iframe srcdoc="<p>x</p>"></iframe>`;',
      'export const b = () => html`<div title="t"></div>`;',
    ].join("\n");
    const plan = planHtmlTemplates(code);
    expect(plan.compiledCount).toBe(1);
    expect(plan.skippedCount).toBe(1);
  });
});

// ─── contextual rules through static/runtime combinations ───────────────────

describe("contextual rules hold across static/runtime combinations", () => {
  const SCRIPT_ATTRS = ["src", "href", "xlink:href", "type", "language", "SRC", "Type"];

  it("runtime values never choose a script, HTML or SVG; static source may", () => {
    for (const name of SCRIPT_ATTRS) {
      const htmlScript = document.createElement("script");
      bindAttrs(htmlScript, { [name]: "https://cdn.example.com/x.js" });
      expect(htmlScript.getAttributeNames(), name).toEqual([]);

      const svgScript = document.createElementNS(SVG_NS, "script");
      bindAttribute(svgScript as unknown as HTMLElement, name, () => "/x.js");
      expect(svgScript.getAttributeNames(), `svg ${name}`).toEqual([]);
      expect(svgScript.getAttributeNS(XLINK_NS, "href")).toBeNull();
    }
    expect(html`<script src="/app.js" type="module"></script>`.getAttributeNames().sort()).toEqual(["src", "type"]);
    expect(html`<script src=${"/app.js"} type="module"></script>`.hasAttribute("src")).toBe(false);
  });

  it("no SVG animation element can be retargeted by runtime data", () => {
    const TARGETS = [
      "href",
      "HREF",
      "xlink:href",
      "XLINK:HREF",
      " href",
      "\u0001href",
      "hr\u0000ef",
      "onbegin",
      "srcdoc",
    ];
    for (const tag of ["animate", "set", "animateMotion", "animateTransform", "animateColor"]) {
      for (const target of TARGETS) {
        const viaFactory = tagFactory(tag, SVG_NS)({ to: "javascript:alert(1)", attributeName: target });
        expect(viaFactory.hasAttribute("attributeName"), `${tag} ${JSON.stringify(target)}`).toBe(false);
        const viaHelper = svgElement(tag, { attributeName: target });
        expect(viaHelper.hasAttribute("attributeName")).toBe(false);
        const [t, setT] = signal("fill");
        const viaReactive = document.createElementNS(SVG_NS, tag);
        bindAttribute(viaReactive as unknown as HTMLElement, "attributeName", () => t());
        setT(target);
        expect(viaReactive.hasAttribute("attributeName")).toBe(false);
      }
      expect(svgElement(tag, { attributeName: "opacity" }).getAttribute("attributeName")).toBe("opacity");
    }
  });
});
