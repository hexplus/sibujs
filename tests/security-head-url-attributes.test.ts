/**
 * URL-attribute security in `Head()` — `link`, `script`, `meta`, and `base`.
 *
 * THE BUG THIS FILE EXISTS FOR
 * ---------------------------
 * `head.ts` classified URL sinks with a private, CASE-SENSITIVE set:
 *
 *     const HEAD_URL_ATTRS = new Set(["href", "src"]);
 *     if (HEAD_URL_ATTRS.has(key)) return sanitizeUrl(value);
 *
 * HTML attribute names are ASCII case-insensitive, so the browser reads `SRC` as
 * `src` — but that lookup did not. `Head({ script: [{ SRC: "data:…" }] })`
 * therefore skipped sanitization completely and wrote the attribute verbatim,
 * while both SSR paths (which lower-cased first) refused the identical value.
 * The framework's own `isUrlAttribute()` carries a comment warning about exactly
 * this mistake; `head.ts` simply was not using it.
 *
 * Classification now runs on the CANONICAL (ASCII-lower-cased) name, computed
 * once in `utils/headEntry.ts` and used for URL policy, event handlers,
 * `srcdoc`, and duplicate detection alike.
 *
 * THE SECOND RULE: REJECTED MEANS OMITTED
 * --------------------------------------
 * A refused URL used to be published as `href=""`. That is not the same
 * document. An empty URL attribute resolves against the current page, so
 * `<link href="">` references the page itself and `<script src="">` is a request
 * rather than a no-op. A rejected value is dropped from the attribute map.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { Head, setCanonical } from "../src/platform/head";

/** Every casing an attacker might reach for. */
const CASINGS = (name: string) => [name.toLowerCase(), name.toUpperCase(), `${name[0].toUpperCase()}${name.slice(1)}`];

const DANGEROUS = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/javascript,globalThis.__sibuHeadXss=1",
  "vbscript:msgbox(1)",
  "blob:https://example.com/id",
  "file:///etc/passwd",
  "about:blank",
  "custom-scheme:payload",
  "java\tscript:alert(1)",
  "  javascript:alert(1)  ",
];

const SAFE = ["/local.css", "https://example.com/a.css", "//example.com/a.css", "#frag", "relative/a.css"];

function cleanHead() {
  for (const el of Array.from(document.head.querySelectorAll("meta,link,script"))) el.remove();
}

beforeEach(cleanHead);
afterEach(cleanHead);

// ─── the mandated exploit regression ────────────────────────────────────────

describe("the mixed-case script SRC exploit", () => {
  it("never publishes the dangerous src, in any form", () => {
    const head = Head({
      script: [{ SRC: "data:text/javascript,globalThis.__sibuHeadXss=1" }],
    });

    const scripts = Array.from(document.head.querySelectorAll("script"));
    for (const el of scripts) {
      // Not present…
      expect(el.hasAttribute("src"), "the dangerous src survived").toBe(false);
      // …and not replaced by an empty substitute either.
      expect(el.getAttribute("src")).toBeNull();
    }
    // The entry had nothing else, so nothing is published at all.
    expect(scripts).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).__sibuHeadXss).toBeUndefined();
    dispose(head);
  });

  it("never publishes a mixed-case link HREF", () => {
    const head = Head({ link: [{ rel: "stylesheet", HREF: "javascript:alert(1)" }] });

    const link = document.head.querySelector("link");
    expect(link, "the safe half of the entry was lost").not.toBeNull();
    expect(link?.hasAttribute("href"), "the dangerous href survived").toBe(false);
    expect(link?.getAttribute("rel")).toBe("stylesheet");
    dispose(head);
  });
});

// ─── every casing × every value, for link and script ────────────────────────

for (const [tag, urlAttr] of [
  ["link", "href"],
  ["script", "src"],
] as const) {
  describe(`Head({ ${tag} }) URL policy`, () => {
    for (const spelling of CASINGS(urlAttr)) {
      for (const url of DANGEROUS) {
        it(`rejects ${spelling}=${JSON.stringify(url)}`, () => {
          const head = Head({ [tag]: [{ rel: "keep", [spelling]: url }] } as never);
          const el = document.head.querySelector(tag);
          expect(el, "the rest of the entry was dropped").not.toBeNull();
          expect(el?.hasAttribute(urlAttr), `${spelling} survived`).toBe(false);
          // Nor under the authored spelling — `getAttribute` is case-insensitive
          // on HTML elements, but assert the attribute list too.
          expect(Array.from(el?.attributes ?? []).map((a) => a.name)).toEqual(["rel"]);
          dispose(head);
        });
      }

      for (const url of SAFE) {
        it(`accepts ${spelling}=${JSON.stringify(url)}`, () => {
          const head = Head({ [tag]: [{ rel: "keep", [spelling]: url }] } as never);
          const el = document.head.querySelector(tag);
          expect(el?.getAttribute(urlAttr), `${spelling} was rejected`).toBe(url);
          dispose(head);
        });
      }
    }

    it("rejects a duplicate spelling of the URL attribute outright", () => {
      // The dangerous half would overwrite the safe half in the DOM, so the
      // value validated would not be the value committed.
      const head = Head({
        [tag]: [{ rel: "keep", [urlAttr]: "/safe.css", [urlAttr.toUpperCase()]: "javascript:alert(1)" }],
      } as never);
      expect(document.head.querySelector(tag), "a duplicate-casing entry was published").toBeNull();
      dispose(head);
    });

    it("drops srcdoc in every casing", () => {
      for (const spelling of ["srcdoc", "SRCDOC", "SrcDoc"]) {
        const head = Head({ [tag]: [{ rel: "keep", [spelling]: "<script>globalThis.__x=1</script>" }] } as never);
        const el = document.head.querySelector(tag);
        expect(el?.hasAttribute("srcdoc"), `${spelling} survived`).toBe(false);
        expect(Array.from(el?.attributes ?? []).map((a) => a.name)).toEqual(["rel"]);
        dispose(head);
        cleanHead();
      }
    });

    it("drops the whole entry when nothing effective remains", () => {
      const head = Head({ [tag]: [{ [urlAttr]: "javascript:alert(1)" }] } as never);
      expect(document.head.querySelector(tag)).toBeNull();
      dispose(head);
    });

    it("emits canonical attribute names", () => {
      const head = Head({ [tag]: [{ REL: "keep", [urlAttr.toUpperCase()]: "/ok" }] } as never);
      const el = document.head.querySelector(tag);
      expect(
        Array.from(el?.attributes ?? [])
          .map((a) => a.name)
          .sort(),
      ).toEqual(["rel", urlAttr].sort());
      dispose(head);
    });
  });
}

// ─── meta entries, including reactive updates ───────────────────────────────

describe("Head({ meta }) URL policy across reactive updates", () => {
  // `HeadProps["meta"]` is the one entry type whose values may be getters, so
  // this is where "unsafe cannot transiently reach a connected element" is
  // actually testable.
  const connectedWrites: string[] = [];

  function recordConnectedWrites<T>(run: () => T): T {
    connectedWrites.length = 0;
    const original = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      if (this.isConnected) connectedWrites.push(`${this.tagName}:${name}=${value}`);
      return original.call(this, name, value);
    };
    try {
      return run();
    } finally {
      Element.prototype.setAttribute = original;
    }
  }

  it("goes safe → unsafe → safe without ever connecting the unsafe value", async () => {
    const { signal } = await import("../src/core/signals/signal");
    const [url, setUrl] = signal("/a.css");

    const head = recordConnectedWrites(() => {
      const h = Head({ meta: [{ name: "x", HREF: () => url() }] });
      setUrl("javascript:alert(1)");
      setUrl("/b.css");
      return h;
    });

    expect(connectedWrites, "a connected element was mutated in place").toEqual([]);
    const el = document.head.querySelector("meta");
    expect(el?.getAttribute("href")).toBe("/b.css");
    dispose(head);
  });

  it("omits the attribute while the reactive value is unsafe", async () => {
    const { signal } = await import("../src/core/signals/signal");
    const [url, setUrl] = signal("/a.css");
    const head = Head({ meta: [{ name: "x", SRC: () => url() }] });

    expect(document.head.querySelector("meta")?.getAttribute("src")).toBe("/a.css");

    setUrl("data:text/html,x");
    const during = document.head.querySelector("meta");
    expect(during?.hasAttribute("src"), "an unsafe reactive value was published").toBe(false);
    expect(during?.getAttribute("name"), "the rest of the entry was lost").toBe("x");

    setUrl("/c.css");
    expect(document.head.querySelector("meta")?.getAttribute("src")).toBe("/c.css");
    dispose(head);
  });

  it("drops the entry entirely when the reactive value is its only attribute", async () => {
    const { signal } = await import("../src/core/signals/signal");
    const [url, setUrl] = signal("/a.css");
    const head = Head({ meta: [{ HREF: () => url() }] });

    expect(document.head.querySelectorAll("meta")).toHaveLength(1);
    setUrl("javascript:alert(1)");
    expect(document.head.querySelectorAll("meta"), "an empty entry was published").toHaveLength(0);
    setUrl("/b.css");
    expect(document.head.querySelector("meta")?.getAttribute("href")).toBe("/b.css");
    dispose(head);
  });

  it("leaves nothing behind after disposal following unsafe updates", async () => {
    const { signal } = await import("../src/core/signals/signal");
    const [url, setUrl] = signal("/a.css");
    const head = Head({ meta: [{ name: "x", href: () => url() }] });

    setUrl("javascript:alert(1)");
    setUrl("/b.css");
    setUrl("file:///etc/passwd");
    dispose(head);

    expect(document.head.querySelectorAll("meta")).toHaveLength(0);
    setUrl("/c.css");
    expect(document.head.querySelectorAll("meta"), "a disposed entry was republished").toHaveLength(0);
  });
});

// ─── base and canonical ─────────────────────────────────────────────────────

describe("base and canonical URLs", () => {
  it("omits a rejected base href but keeps the element", () => {
    const head = Head({ base: { href: "javascript:alert(1)", target: "_self" } });
    const base = document.head.querySelector("base");
    expect(base?.hasAttribute("href")).toBe(false);
    expect(base?.getAttribute("target")).toBe("_self");
    dispose(head);
    for (const el of Array.from(document.head.querySelectorAll("base"))) el.remove();
  });

  it("omits a rejected canonical href and clears a previously accepted one", () => {
    setCanonical("https://example.com/page");
    const link = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement;
    expect(link.getAttribute("href")).toBe("https://example.com/page");

    setCanonical("javascript:alert(1)");
    // Neither `href=""` (which would declare the page canonical to itself) nor
    // the stale previous value.
    expect(link.hasAttribute("href")).toBe(false);
    for (const el of Array.from(document.head.querySelectorAll("link"))) el.remove();
  });
});
