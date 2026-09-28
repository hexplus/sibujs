/**
 * The CONTEXTUAL element policy (`src/utils/elementPolicy.ts`) must reach the
 * same verdict through every framework path that can write an attribute.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `setSafeAttribute(el, name, value)` used to judge `(name, value)` alone. For
 * `<meta http-equiv="refresh" content="…">` that is not enough: `content` is
 * inert text on `<meta name="description">` and a navigation on a refresh
 * directive, and only the element knows which. `Head()` assembled whole
 * entries and refused the directive, while `meta()`, `tagFactory("meta")`,
 * `html```, `bindAttrs`, the reactive bindings, `enhance()` and the SSR
 * serializers all published it:
 *
 *     meta({ "http-equiv": "refresh", content: attackerValue })   // was: live
 *
 * The same shape — a verdict that depends on the element, reached by a path
 * that only had the pair — also held for `<script src>` (a runtime value in an
 * `html``` template chose which program ran) and SVG `<set attributeName>`.
 *
 * Every table below runs ONE payload list through EVERY applicable path, and
 * asserts both the final state and every intermediate state: a check that runs
 * after the write is not a defence for a sink that acts the moment it becomes
 * valid.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { html } from "../src/core/rendering/htm";
import { customElement, meta } from "../src/core/rendering/html";
import { SVG_NS, tagFactory } from "../src/core/rendering/tagFactory";
import { signal } from "../src/core/signals/signal";
import { DOMPool } from "../src/performance/domRecycler";
import { svgElement } from "../src/platform/customElement";
import { enhance } from "../src/platform/enhance";
import { Head } from "../src/platform/head";
import { collectStream, renderToDocument, renderToStream, renderToString } from "../src/platform/ssr";
import { bindAttribute, bindDynamic } from "../src/reactivity/bindAttribute";
import { bindAttrs } from "../src/ui/reactiveAttr";
import { contextualAttributeRefusal, isBlockedElement } from "../src/utils/elementPolicy";
import { type MetaRefreshDecision, resolveMetaRefreshPolicy } from "../src/utils/metaRefresh";

const XLINK_NS = "http://www.w3.org/1999/xlink";

// ─── helpers ────────────────────────────────────────────────────────────────

function attributeMap(el: Element): Map<string, string> {
  const map = new Map<string, string>();
  for (const attr of Array.from(el.attributes)) map.set(attr.name, attr.value);
  return map;
}

function verdict(el: Element): MetaRefreshDecision["kind"] {
  return resolveMetaRefreshPolicy(attributeMap(el)).kind;
}

/**
 * Record the refresh verdict of every `<meta>` touched by an attribute
 * mutation, immediately after the mutation. Element state only changes through
 * these operations, so the log is the COMPLETE trace of states — including the
 * ones that exist only between two writes.
 */
const trace: { kind: MetaRefreshDecision["kind"]; attrs: string }[] = [];
const originals: [object, string, unknown][] = [];

function installTrace(): void {
  for (const method of ["setAttribute", "setAttributeNS", "removeAttribute", "removeAttributeNS"] as const) {
    const proto = Element.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const original = proto[method];
    originals.push([proto, method, original]);
    proto[method] = function (this: Element, ...args: unknown[]) {
      const result = original.apply(this, args);
      if (this.localName === "meta") {
        trace.push({ kind: verdict(this), attrs: JSON.stringify(Array.from(attributeMap(this))) });
      }
      return result;
    };
  }
}

function removeTrace(): void {
  for (const [proto, method, original] of originals.splice(0)) {
    (proto as Record<string, unknown>)[method] = original;
  }
  trace.length = 0;
}

// ─── meta refresh: payloads ─────────────────────────────────────────────────

/**
 * Directives the shared policy must refuse. Obfuscations, encodings, separator
 * games and ambiguous grammar all included: the attacker picks the spelling.
 */
const FORBIDDEN_CONTENT: string[] = [
  "0;url=javascript:alert(1)",
  "0;URL=JAVASCRIPT:alert(1)",
  "0;url= javaScript:alert(1)",
  "0; url = javascript:alert(1)",
  "0 ;\turl\t=\tjavascript:alert(1)",
  "0;url=java\tscript:alert(1)",
  "0;url=java\nscript:alert(1)",
  "0;url=java\rscript:alert(1)",
  "0;url=java\u0000script:alert(1)",
  "0;url=\u0001javascript:alert(1)",
  "0;url=\u0085javascript:alert(1)",
  "\u0001\u0002 0;url=javascript:alert(1) \u0003",
  "0;url='javascript:alert(1)'",
  '0;url="javascript:alert(1)"',
  "0;url='javascript:alert(1)",
  "0;url=data:text/html,<script>alert(1)</script>",
  "0;url=DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "0;url=vbscript:msgbox(1)",
  "0;url=file:///etc/passwd",
  "0;url=blob:https://example.com/uuid",
  "0;url=/safe;url=javascript:alert(1)",
  "0;url=/safe,url=javascript:alert(1)",
  "0,url=javascript:alert(1)",
  "0; javascript:alert(1)",
  "0;foo=/safe",
  "x;url=/safe",
  "0url=/safe",
  "0;url=",
];

/** Directives a STATIC path must keep publishing — the policy is not a blanket ban. */
const ALLOWED_CONTENT: string[] = [
  "5",
  "5;url=/safe",
  "0; URL='https://example.com/next'",
  "3,url=https://example.com/",
  // Entity text is NOT decoded by the DOM: this is the literal relative URL
  // `jav&#x61script:…` (a `#` starts its fragment), which a browser resolves
  // same-origin. Decoding it here would be the over-decoding the policy must
  // not do. (With a `;` terminator the parser refuses it instead — see
  // "multiple refresh assignments" — which is conservative, not a decode.)
  "0;url=jav&#x61script:alert(1)",
  "0;url=%6a%61%76%61%73%63%72%69%70%74:alert(1)",
];

// ─── meta refresh: every path ───────────────────────────────────────────────

interface MetaPath {
  label: string;
  /** Reactive paths may never hold ANY directive; static ones may hold a safe one. */
  reactive: boolean;
  build(content: string): Element;
}

const META_PATHS: MetaPath[] = [
  {
    label: "meta() props",
    reactive: false,
    build: (c) => meta({ "http-equiv": "refresh", content: c }),
  },
  {
    label: "meta() props, content first",
    reactive: false,
    build: (c) => meta({ content: c, "http-equiv": "refresh" }),
  },
  {
    label: 'meta() props, "HTTP-EQUIV" casing',
    reactive: false,
    build: (c) => meta({ "HTTP-EQUIV": "REFRESH", CONTENT: c }),
  },
  {
    label: 'tagFactory("meta")',
    reactive: false,
    build: (c) => tagFactory("meta")({ "http-equiv": "refresh", content: c }),
  },
  {
    label: 'customElement("meta")',
    reactive: false,
    build: (c) => customElement("meta")({ content: c, "http-equiv": "refresh" }),
  },
  {
    label: "html`` expression content after static http-equiv",
    reactive: false,
    build: (c) => html`<meta http-equiv="refresh" content=${c}>`,
  },
  {
    label: "html`` expression content BEFORE static http-equiv",
    reactive: false,
    build: (c) => html`<meta content=${c} http-equiv="refresh">`,
  },
  {
    label: "html`` quoted (mixed) content",
    reactive: false,
    build: (c) => html`<meta http-equiv="refresh" content="${c}">`,
  },
  {
    label: "html`` expression http-equiv",
    reactive: false,
    build: (c) => html`<meta content=${c} http-equiv=${"refresh"}>`,
  },
  {
    label: "bindAttrs static values",
    reactive: false,
    build: (c) => {
      const el = document.createElement("meta");
      bindAttrs(el, { content: c, "http-equiv": "refresh" });
      return el;
    },
  },
  {
    label: "meta() with a reactive content getter",
    reactive: true,
    build: (c) => {
      const [value, setValue] = signal("harmless");
      const el = meta({ "http-equiv": "refresh", content: () => value() });
      setValue(c);
      return el;
    },
  },
  {
    label: "meta() with a reactive content getter written first",
    reactive: true,
    build: (c) => {
      const [value, setValue] = signal("harmless");
      const el = meta({ content: () => value(), "http-equiv": "refresh" });
      setValue(c);
      return el;
    },
  },
  {
    label: "meta() with a reactive http-equiv flipping to refresh",
    reactive: true,
    build: (c) => {
      const [equiv, setEquiv] = signal("x-custom");
      const el = meta({ content: c, "http-equiv": () => equiv() });
      setEquiv("refresh");
      return el;
    },
  },
  {
    // The directive itself is STATIC: only an unrelated attribute is live, and
    // it cannot create or redirect a refresh. So this path is judged like the
    // static ones — forbidden refused, allowed kept. See `reactiveMetaElements`.
    label: "meta() static directive beside an unrelated reactive attribute",
    reactive: false,
    build: (c) => {
      const [label] = signal("n");
      return meta({ "http-equiv": "refresh", content: c, "data-state": () => label() });
    },
  },
  {
    label: "html`` reactive content getter",
    reactive: true,
    build: (c) => {
      const [value, setValue] = signal("harmless");
      const el = html`<meta http-equiv="refresh" content=${() => value()}>`;
      setValue(c);
      return el;
    },
  },
  {
    label: "bindAttribute on a connected element",
    reactive: true,
    build: (c) => {
      const el = document.createElement("meta");
      document.head.appendChild(el);
      bindAttrs(el, { "http-equiv": "refresh" });
      const [value, setValue] = signal("harmless");
      bindAttribute(el, "content", () => value());
      setValue(c);
      return el;
    },
  },
  {
    label: "bindDynamic whose NAME becomes content",
    reactive: true,
    build: (c) => {
      const el = document.createElement("meta");
      bindAttrs(el, { "http-equiv": "refresh" });
      const [name, setName] = signal("data-x");
      bindDynamic(el, () => name(), c);
      setName("content");
      return el;
    },
  },
  {
    label: "enhance() attr() on server markup",
    reactive: true,
    build: (c) => {
      const root = document.createElement("div");
      root.innerHTML = '<meta id="m" http-equiv="refresh">';
      document.body.appendChild(root);
      enhance(root, ({ attr }) => {
        attr("#m", "content", () => c);
      });
      return root.querySelector("#m") as Element;
    },
  },
];

beforeEach(() => {
  installTrace();
});

afterEach(() => {
  removeTrace();
  for (const m of Array.from(document.head.querySelectorAll("meta"))) m.remove();
  document.body.innerHTML = "";
});

describe("meta refresh — forbidden directives, every path", () => {
  for (const path of META_PATHS) {
    describe(path.label, () => {
      for (const content of FORBIDDEN_CONTENT) {
        it(`refuses ${JSON.stringify(content)}`, () => {
          const el = path.build(content);
          expect(verdict(el)).not.toBe("forbidden");
          if (path.reactive) expect(verdict(el)).toBe("not-refresh");
          // Never, not even between two writes.
          expect(trace.filter((t) => t.kind === "forbidden")).toEqual([]);
        });
      }
    });
  }
});

describe("meta refresh — allowed directives stay allowed on static paths", () => {
  for (const path of META_PATHS.filter((p) => !p.reactive)) {
    for (const content of ALLOWED_CONTENT) {
      it(`${path.label} keeps ${JSON.stringify(content)}`, () => {
        const el = path.build(content);
        expect(el.getAttribute("content")).toBe(content);
        expect(el.getAttribute("http-equiv")?.toLowerCase()).toBe("refresh");
      });
    }
  }

  it("ordinary reactive meta entries are unaffected", () => {
    const [description, setDescription] = signal("first");
    const el = meta({ name: "description", content: () => description() });
    setDescription("0;url=javascript:alert(1) is just text here");
    expect(el.getAttribute("content")).toBe("0;url=javascript:alert(1) is just text here");
  });
});

describe("meta refresh — reactive paths never publish ANY directive", () => {
  for (const path of META_PATHS.filter((p) => p.reactive)) {
    for (const content of ALLOWED_CONTENT) {
      it(`${path.label} withholds ${JSON.stringify(content)}`, () => {
        const el = path.build(content);
        expect(verdict(el)).toBe("not-refresh");
        // A connected reactive meta must never have been a directive at all.
        const connectedDirectives = trace.filter((t) => t.kind === "allowed" || t.kind === "delay-only");
        if (el.isConnected) expect(connectedDirectives).toEqual([]);
      });
    }
  }

  it("a reactive refresh-relevant binding claims an element that already holds a directive, and withdraws it", () => {
    for (const name of ["content", "CONTENT", "Content", "http-equiv", "HTTP-EQUIV", "Http-Equiv"]) {
      const el = document.createElement("meta");
      bindAttrs(el, { "http-equiv": "refresh", content: "5;url=/safe" });
      expect(verdict(el)).toBe("allowed");
      const lower = name.toLowerCase();
      bindAttribute(el, name, () => (lower === "content" ? "5;url=/safe" : "refresh"));
      expect(verdict(el), name).toBe("not-refresh");
    }
  });

  it("a reactive binding whose first value REMOVES the attribute still claims the element", () => {
    const el = document.createElement("meta");
    const [value, setValue] = signal<string | null>(null);
    bindAttribute(el, "content", () => value());
    bindAttrs(el, { "http-equiv": "refresh" });
    setValue("5;url=/safe");
    expect(verdict(el)).toBe("not-refresh");
  });

  it("disposing the owner does not re-enable the element", () => {
    const [value, setValue] = signal("harmless");
    const el = meta({ "http-equiv": "refresh", content: () => value() });
    setValue("5;url=/safe");
    dispose(el);
    bindAttrs(el as HTMLElement, { content: "5;url=/safe" });
    expect(verdict(el)).toBe("not-refresh");
  });
});

describe("meta refresh — fully static html`` source", () => {
  it("a static forbidden directive is refused (the rule holds regardless of source)", () => {
    const el = html`<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`;
    expect(verdict(el)).not.toBe("forbidden");
    expect(trace.filter((t) => t.kind === "forbidden")).toEqual([]);
  });

  it("a static safe directive is developer-authored and kept", () => {
    const el = html`<meta http-equiv="refresh" content="5;url=/next">`;
    expect(verdict(el)).toBe("allowed");
  });

  it("static source is not entity-decoded, so no javascript: URL is ever formed", () => {
    // A browser parsing this markup from an HTML file WOULD decode `&#x61`
    // (numeric references need no `;` in attribute values) into `javascript:`.
    // The template parser does not decode, so the value stays the literal
    // relative URL — and the SSR round trip must escape the `&` so the browser
    // parsing the server HTML does not decode it either.
    const el = html`<meta http-equiv="refresh" content="0;url=jav&#x61script:alert(1)">`;
    expect(el.getAttribute("content")).toBe("0;url=jav&#x61script:alert(1)");
    const doc = new DOMParser().parseFromString(renderToString(el), "text/html");
    expect(doc.querySelector("meta")?.getAttribute("content")).toBe("0;url=jav&#x61script:alert(1)");
  });

  it("a `;`-terminated entity is refused outright by the strict grammar", () => {
    const el = html`<meta http-equiv="refresh" content="0;url=jav&#x61;script:alert(1)">`;
    expect(el.hasAttribute("content")).toBe(false);
  });
});

describe("meta refresh — Head() and renderToDocument agree with the DOM paths", () => {
  for (const content of FORBIDDEN_CONTENT) {
    it(`drops ${JSON.stringify(content)}`, () => {
      const anchor = Head({ meta: [{ "http-equiv": "refresh", content }] });
      expect(Array.from(document.head.querySelectorAll("meta")).map(verdict)).not.toContain("forbidden");
      dispose(anchor);
      const page = renderToDocument(() => document.createElement("div"), {
        meta: [{ "http-equiv": "refresh", content }],
      });
      const doc = new DOMParser().parseFromString(page, "text/html");
      expect(Array.from(doc.querySelectorAll("meta")).map(verdict)).not.toContain("forbidden");
    });
  }
});

// ─── SSR parity ─────────────────────────────────────────────────────────────

async function ssrBoth(el: Element): Promise<{ string: string; stream: string }> {
  return {
    string: renderToString(el),
    stream: await collectStream(renderToStream(el)),
  };
}

function parsedMetas(markup: string): Element[] {
  return Array.from(
    new DOMParser().parseFromString(`<!doctype html><body>${markup}`, "text/html").querySelectorAll("meta"),
  );
}

describe("meta refresh — SSR of framework-built DOM matches the client", () => {
  for (const path of META_PATHS.filter((p) => !p.reactive)) {
    it(`${path.label}: string and stream renderers agree and emit nothing forbidden`, async () => {
      for (const content of [...FORBIDDEN_CONTENT, ...ALLOWED_CONTENT]) {
        const el = path.build(content);
        const out = await ssrBoth(el);
        expect(out.stream).toBe(out.string);
        for (const m of parsedMetas(out.string)) expect(verdict(m)).not.toBe("forbidden");
      }
    });
  }
});

describe("meta refresh — SSR of FOREIGN DOM (built without the framework)", () => {
  for (const content of FORBIDDEN_CONTENT) {
    it(`drops a raw-built <meta> carrying ${JSON.stringify(content)}`, async () => {
      const wrapper = document.createElement("div");
      const el = document.createElement("meta");
      // Application code bypassing every framework writer on purpose.
      Element.prototype.setAttribute.call(el, "http-equiv", "refresh");
      Element.prototype.setAttribute.call(el, "content", content);
      wrapper.appendChild(el);
      const out = await ssrBoth(wrapper);
      expect(out.stream).toBe(out.string);
      for (const m of parsedMetas(out.string)) expect(verdict(m)).not.toBe("forbidden");
    });
  }

  it("keeps a raw-built safe directive", () => {
    const el = document.createElement("meta");
    el.setAttribute("http-equiv", "refresh");
    el.setAttribute("content", "5;url=/next");
    expect(parsedMetas(renderToString(el)).map(verdict)).toEqual(["allowed"]);
  });

  it("rejects a foreign duplicate casing (setAttributeNS) instead of guessing", () => {
    const el = document.createElement("meta");
    el.setAttribute("http-equiv", "x-custom");
    el.setAttributeNS(null, "HTTP-EQUIV", "refresh");
    el.setAttribute("content", "0;url=/next");
    expect(renderToString(el)).not.toContain("content=");
  });
});

// ─── <script>: runtime values may not choose the program ────────────────────

describe("script sources — a runtime value never chooses the code that runs", () => {
  const SOURCES = [
    "https://cdn.example.com/widget.js",
    "//cdn.example.com/widget.js",
    "/assets/app.js",
    "javascript:alert(1)",
    "data:text/javascript,alert(1)",
  ];

  for (const src of SOURCES) {
    it(`html\`<script src=\${${JSON.stringify(src)}}>\` has no src`, () => {
      const el = html`<script src=${src}></script>`;
      expect(el.hasAttribute("src")).toBe(false);
    });

    it(`html\`<script src="\${…}">\` (mixed) has no src for ${JSON.stringify(src)}`, () => {
      const el = html`<script src="${src}"></script>`;
      expect(el.hasAttribute("src")).toBe(false);
    });

    it(`a reactive src getter never lands for ${JSON.stringify(src)}`, () => {
      const [value, setValue] = signal("/first.js");
      const el = html`<script src=${() => value()}></script>`;
      setValue(src);
      expect(el.hasAttribute("src")).toBe(false);
    });
  }

  it("runtime type / language / SVG href are refused too", () => {
    expect(html`<script type=${"module"}></script>`.hasAttribute("type")).toBe(false);
    expect(html`<script language=${"javascript"}></script>`.hasAttribute("language")).toBe(false);
    const svgScript = document.createElementNS(SVG_NS, "script");
    bindAttrs(svgScript as unknown as HTMLElement, { href: "/x.js", "xlink:href": "/y.js" });
    expect(svgScript.hasAttribute("href")).toBe(false);
    expect(svgScript.getAttributeNS(XLINK_NS, "href")).toBeNull();
  });

  it("non-source attributes on a script keep working (e.g. a runtime nonce)", () => {
    const el = html`<script nonce=${"r4nd0m"} async></script>`;
    expect(el.getAttribute("nonce")).toBe("r4nd0m");
    expect(el.hasAttribute("async")).toBe(true);
  });

  it("static template source is developer-authored and keeps its src (documented trust boundary)", () => {
    const el = html`<script src="/static/app.js" type="module"></script>`;
    expect(el.getAttribute("src")).toBe("/static/app.js");
    expect(el.getAttribute("type")).toBe("module");
  });

  it("bindAttrs / bindAttribute / enhance on an application-created script refuse the source", () => {
    const a = document.createElement("script");
    bindAttrs(a, { src: "https://cdn.example.com/x.js" });
    expect(a.hasAttribute("src")).toBe(false);

    const b = document.createElement("script");
    bindAttribute(b, "src", () => "https://cdn.example.com/x.js");
    expect(b.hasAttribute("src")).toBe(false);

    const root = document.createElement("div");
    root.innerHTML = '<script id="s" type="application/json">{}</script>';
    enhance(root, ({ attr }) => {
      attr("#s", "type", () => "module");
    });
    // RECONCILED: the slot the binding claimed is cleared rather than left
    // holding a value it did not choose.
    expect(root.querySelector("#s")?.hasAttribute("type")).toBe(false);
  });

  it("removing a script source is always allowed", () => {
    const el = document.createElement("script");
    el.setAttribute("src", "/app.js");
    bindAttrs(el, { src: null });
    expect(el.hasAttribute("src")).toBe(false);
  });
});

// ─── SVG animation: attributeName decides what to/values write ──────────────

describe("SVG animation — attributeName may not retarget a link, handler or document", () => {
  const set = tagFactory("set", SVG_NS);
  const animate = tagFactory("animate", SVG_NS);

  const DANGEROUS_TARGETS = ["href", "HREF", "xlink:href", " href", "hr\tef", "src", "onclick", "onbegin", "srcdoc"];
  for (const target of DANGEROUS_TARGETS) {
    it(`<set attributeName=${JSON.stringify(target)}> is refused, in either prop order`, () => {
      const a = set({ attributeName: target, to: "javascript:alert(1)" });
      expect(a.hasAttribute("attributeName")).toBe(false);
      const b = set({ to: "javascript:alert(1)", attributeName: target });
      expect(b.hasAttribute("attributeName")).toBe(false);
      const c = svgElement("animate", { attributeName: target, values: "javascript:alert(1)" });
      expect(c.hasAttribute("attributeName")).toBe(false);
    });
  }

  it("presentation targets keep working", () => {
    for (const target of ["fill", "opacity", "x", "transform", "stroke-width"]) {
      expect(animate({ attributeName: target, to: "1" }).getAttribute("attributeName")).toBe(target);
    }
  });

  it("a reactive attributeName that turns dangerous is withdrawn", () => {
    const [target, setTarget] = signal("fill");
    const el = animate({ attributeName: () => target(), to: "javascript:alert(1)" });
    expect(el.getAttribute("attributeName")).toBe("fill");
    setTarget("href");
    expect(el.hasAttribute("attributeName")).toBe(false);
  });

  it("the rule is SVG-only: an HTML element named `set` is inert", () => {
    expect(contextualAttributeRefusal(document.createElement("set"), "attributeName", "href", "runtime")).toBe(0);
  });
});

// ─── SVG URL sinks and namespaces ───────────────────────────────────────────

describe("SVG URL attributes — namespace handling never bypasses the URL policy", () => {
  const DANGEROUS = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "\u0001javascript:alert(1)",
    "java\tscript:alert(1)",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "vbscript:x",
  ];

  for (const url of DANGEROUS) {
    it(`refuses ${JSON.stringify(url)} on SVG href and xlink:href, every writer`, () => {
      const viaHelper = svgElement("a", { href: url, "xlink:href": url });
      const viaFactory = tagFactory("use", SVG_NS)({ href: url, "xlink:href": url });
      const viaTemplate = html`<svg><use href=${url}></use></svg>`.firstElementChild as Element;
      const viaReactive = document.createElementNS(SVG_NS, "image");
      bindAttribute(viaReactive as unknown as HTMLElement, "xlink:href", () => url);

      for (const el of [viaHelper, viaFactory, viaTemplate, viaReactive]) {
        expect(el.getAttribute("href")).toBeNull();
        expect(el.getAttributeNS(XLINK_NS, "href")).toBeNull();
        expect(el.getAttribute("xlink:href")).toBeNull();
      }
    });
  }

  it("safe references are written in the XLink namespace", () => {
    const el = tagFactory("use", SVG_NS)({ "xlink:href": "#icon-star" });
    expect(el.getAttributeNS(XLINK_NS, "href")).toBe("#icon-star");
  });
});

// ─── dangerous elements: one list, every runtime-tag-name path ──────────────

describe("dangerous elements — one shared list for every runtime tag name", () => {
  const TAGS = ["script", "SCRIPT", "iframe", "IFrame", "object", "embed", "frame", "frameset"];
  const pool = new DOMPool();

  for (const tag of TAGS) {
    it(`<${tag}> is refused by every path that takes a runtime tag name`, () => {
      expect(isBlockedElement(tag)).toBe(true);
      expect(() => tagFactory(tag)()).toThrow(/blocked/);
      expect(() => tagFactory(tag, SVG_NS)()).toThrow(/blocked/);
      expect(() => customElement(tag)()).toThrow(/blocked/);
      expect(() => svgElement(tag)).toThrow(/blocked/);
      expect(() => pool.acquire(tag)).toThrow(/blocked/);
    });
  }

  it("ordinary elements are unaffected", () => {
    for (const tag of ["div", "foreignObject", "img", "video", "style", "template", "noscript"]) {
      expect(isBlockedElement(tag)).toBe(false);
    }
    expect(svgElement("foreignObject").localName).toBe("foreignObject");
    expect(pool.acquire("div").localName).toBe("div");
  });

  it("static html`` source may still name them — a documented trust boundary", () => {
    expect(html`<iframe title="static"></iframe>`.localName).toBe("iframe");
  });
});
