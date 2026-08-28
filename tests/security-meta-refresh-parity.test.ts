/**
 * `Head()`, `renderToDocument()`, and `renderRouteToDocument()` must produce the
 * EXACT SAME effective attribute map for the same logical entry.
 *
 * WHY "THEY ALL LOOK SAFE" IS NOT THE ASSERTION
 * --------------------------------------------
 * Every earlier version of this file asserted something weaker — the element
 * exists, the output contains no `javascript:`, the dangerous value became an
 * empty string. All three of those pass while the three renderers disagree, and
 * they did disagree, in four separate ways:
 *
 *   - the client classified URL sinks with a case-SENSITIVE set, so `HREF`/`SRC`
 *     skipped sanitization while both servers refused the same value;
 *   - router SSR carried a local scheme BLOCKLIST where the canonical policy is
 *     an ALLOWLIST, so it emitted `file:`, `about:`, `chrome:` and every custom
 *     scheme the other two refused;
 *   - the client kept `srcdoc`, which both servers dropped;
 *   - the client published a refused URL as `href=""` where the servers omitted
 *     the attribute — not the same document, since an empty URL attribute
 *     resolves against the current page.
 *
 * So each row below pins an EXPECTED attribute map and asserts all three against
 * it: emitted-or-not, canonical attribute names, attribute count, and values.
 * Comparing the three only to each other would let a row they all get wrong pass
 * unnoticed; comparing only to an expectation would let a drift between them
 * pass. Both checks are made.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { Head } from "../src/platform/head";
import { renderToDocument } from "../src/platform/ssr";
import { renderRouteToDocument } from "../src/plugins/routerSSR";

type Attrs = Record<string, string> | null;

interface Row {
  label: string;
  entry: Record<string, string>;
  /** The exact effective attribute map, or `null` when no element is emitted. */
  expected: Attrs;
}

const XSS = "javascript:alert(1)";

const TABLE: Row[] = [
  // ── ordinary metadata ───────────────────────────────────────────────────
  {
    label: "description",
    entry: { name: "description", content: "A page" },
    expected: { name: "description", content: "A page" },
  },
  {
    label: "keywords",
    entry: { name: "keywords", content: "a,b,c" },
    expected: { name: "keywords", content: "a,b,c" },
  },
  {
    label: "open graph",
    entry: { property: "og:title", content: "Title" },
    expected: { property: "og:title", content: "Title" },
  },
  {
    label: "non-refresh http-equiv",
    entry: { "http-equiv": "x-ua-compatible", content: "IE=edge" },
    expected: { "http-equiv": "x-ua-compatible", content: "IE=edge" },
  },
  {
    label: "mixed-case ordinary names are canonicalized",
    entry: { NAME: "description", Content: "A page" },
    expected: { name: "description", content: "A page" },
  },
  {
    label: "empty content is a legitimate value",
    entry: { name: "x", content: "" },
    expected: { name: "x", content: "" },
  },

  // ── duplicate names ─────────────────────────────────────────────────────
  // NOTE: identical-casing duplicates cannot reach the framework — a JS object
  // literal collapses `{ href: "a", href: "b" }` to `{ href: "b" }` before any
  // of this runs. The row below pins that collapsed input so all three agree on
  // it; only CASE-DIFFERING duplicates are a decision the framework can make.
  {
    label: "duplicate name, identical casing (collapsed by JS)",
    entry: { name: "x", content: "second" },
    expected: { name: "x", content: "second" },
  },
  {
    label: "duplicate http-equiv casing",
    entry: { "http-equiv": "x-custom", "HTTP-EQUIV": "refresh", content: XSS },
    expected: null,
  },
  {
    label: "duplicate content casing",
    entry: { "http-equiv": "refresh", content: "5;url=/safe", CONTENT: "0;url=data:text/html,x" },
    expected: null,
  },
  {
    label: "duplicate ordinary casing, both safe",
    entry: { name: "description", NAME: "description", content: "ok" },
    expected: null,
  },
  {
    label: "duplicate event-handler casing",
    entry: { name: "description", content: "ok", onload: "a", ONLOAD: "b" },
    expected: null,
  },
  {
    label: "duplicate invalid-name casing",
    entry: { name: "description", content: "ok", "1bad": "a", "1BAD": "b" },
    expected: null,
  },
  { label: "duplicate href casing, safe + dangerous", entry: { name: "x", href: "/safe", HREF: XSS }, expected: null },

  // ── URL attributes, every representative casing ─────────────────────────
  {
    label: "href lowercase, safe relative",
    entry: { name: "x", href: "/a.css" },
    expected: { name: "x", href: "/a.css" },
  },
  {
    label: "HREF uppercase, safe relative",
    entry: { name: "x", HREF: "/a.css" },
    expected: { name: "x", href: "/a.css" },
  },
  { label: "Href mixed, safe relative", entry: { name: "x", Href: "/a.css" }, expected: { name: "x", href: "/a.css" } },
  {
    label: "src lowercase, safe absolute",
    entry: { name: "x", src: "https://example.com/a.js" },
    expected: { name: "x", src: "https://example.com/a.js" },
  },
  {
    label: "SRC uppercase, safe absolute",
    entry: { name: "x", SRC: "https://example.com/a.js" },
    expected: { name: "x", src: "https://example.com/a.js" },
  },
  {
    label: "Src mixed, safe absolute",
    entry: { name: "x", Src: "https://example.com/a.js" },
    expected: { name: "x", src: "https://example.com/a.js" },
  },
  {
    label: "xlink:href mixed case",
    entry: { name: "x", "XLINK:HREF": "/a.svg" },
    expected: { name: "x", "xlink:href": "/a.svg" },
  },
  {
    label: "protocol-relative URL",
    entry: { name: "x", href: "//example.com/a.css" },
    expected: { name: "x", href: "//example.com/a.css" },
  },
  { label: "fragment", entry: { name: "x", href: "#section" }, expected: { name: "x", href: "#section" } },
  { label: "bare relative", entry: { name: "x", href: "a/b.css" }, expected: { name: "x", href: "a/b.css" } },
  {
    label: "mailto",
    entry: { name: "x", href: "mailto:a@b.com?subject=Hello World" },
    expected: { name: "x", href: "mailto:a@b.com?subject=Hello World" },
  },
  { label: "tel", entry: { name: "x", href: "tel:+15551234" }, expected: { name: "x", href: "tel:+15551234" } },
  {
    label: "ftp",
    entry: { name: "x", href: "ftp://example.com/f" },
    expected: { name: "x", href: "ftp://example.com/f" },
  },

  // ── rejected schemes ────────────────────────────────────────────────────
  { label: "javascript:", entry: { name: "x", href: XSS }, expected: { name: "x" } },
  { label: "JAVASCRIPT: uppercase scheme", entry: { name: "x", href: "JAVASCRIPT:alert(1)" }, expected: { name: "x" } },
  {
    label: "JaVaScRiPt: mixed-case scheme",
    entry: { name: "x", HREF: "JaVaScRiPt:alert(1)" },
    expected: { name: "x" },
  },
  { label: "data:", entry: { name: "x", src: "data:text/javascript,globalThis.__x=1" }, expected: { name: "x" } },
  { label: "vbscript:", entry: { name: "x", href: "vbscript:msgbox(1)" }, expected: { name: "x" } },
  { label: "blob:", entry: { name: "x", href: "blob:https://example.com/id" }, expected: { name: "x" } },
  { label: "file:", entry: { name: "x", href: "file:///etc/passwd" }, expected: { name: "x" } },
  { label: "about:", entry: { name: "x", href: "about:blank" }, expected: { name: "x" } },
  { label: "unknown scheme", entry: { name: "x", href: "custom-scheme:payload" }, expected: { name: "x" } },
  { label: "chrome: scheme", entry: { name: "x", href: "chrome://settings" }, expected: { name: "x" } },

  // ── obfuscation ─────────────────────────────────────────────────────────
  { label: "embedded tab in the scheme", entry: { name: "x", href: "java\tscript:alert(1)" }, expected: { name: "x" } },
  {
    label: "embedded newline in the scheme",
    entry: { name: "x", href: "java\nscript:alert(1)" },
    expected: { name: "x" },
  },
  { label: "leading control byte", entry: { name: "x", href: "javascript:alert(1)" }, expected: { name: "x" } },
  {
    label: "leading/trailing whitespace around a dangerous scheme",
    entry: { name: "x", href: "   javascript:alert(1)   " },
    expected: { name: "x" },
  },
  {
    label: "leading/trailing whitespace around a safe URL",
    entry: { name: "x", href: "  https://example.com/a  " },
    expected: { name: "x", href: "https://example.com/a" },
  },
  {
    label: "embedded tab in a safe relative URL",
    entry: { name: "x", href: "/a\tb.css" },
    expected: { name: "x", href: "/a\tb.css" },
  },

  // ── values needing HTML escaping ────────────────────────────────────────
  // The servers escape; the client uses `setAttribute` and does not. These rows
  // prove the two arrive at the same VALUE, which is what the comparison is
  // about — escaping is a serialization detail, not a policy difference.
  {
    label: "value containing quotes and angle brackets",
    entry: { name: "x", content: `a"b'c<d>e&f` },
    expected: { name: "x", content: `a"b'c<d>e&f` },
  },
  {
    label: "URL containing an ampersand and quotes",
    entry: { name: "x", HREF: `https://example.com/a?b=1&c="2"` },
    expected: { name: "x", href: `https://example.com/a?b=1&c="2"` },
  },

  // ── other policy sinks: style and srcset ────────────────────────────────
  // These were a THREE-WAY divergence before this pass: `renderToDocument`
  // filtered `style` per declaration, while the client and router SSR emitted it
  // verbatim. All three now run the canonical `sanitizeAttributeString`.
  {
    label: "style with a dangerous declaration",
    entry: { name: "x", style: "background:url(javascript:alert(1))" },
    expected: { name: "x" },
  },
  {
    label: "style with a safe declaration",
    entry: { name: "x", STYLE: "color:red" },
    // `sanitizeStyleAttribute` re-serializes the declaration list, so the value
    // is normalized (`color: red`) rather than passed through. All three paths
    // must produce the SAME normalization, which is the point of the row.
    expected: { name: "x", style: "color: red" },
  },
  {
    label: "srcset is parsed as a candidate list, not one URL",
    entry: { name: "x", SRCSET: "javascript:alert(1) 1x" },
    expected: { name: "x" },
  },
  {
    label: "srcset with safe candidates",
    entry: { name: "x", srcset: "/a.png 1x, /b.png 2x" },
    expected: { name: "x", srcset: "/a.png 1x, /b.png 2x" },
  },
  {
    label: "manifest is a URL sink on every path",
    entry: { name: "x", MANIFEST: "javascript:alert(1)" },
    expected: { name: "x" },
  },

  // ── srcdoc ──────────────────────────────────────────────────────────────
  {
    label: "srcdoc lowercase",
    entry: { name: "x", srcdoc: "<script>globalThis.__x=1</script>" },
    expected: { name: "x" },
  },
  {
    label: "SRCDOC uppercase",
    entry: { name: "x", SRCDOC: "<script>globalThis.__x=1</script>" },
    expected: { name: "x" },
  },
  { label: "SrcDoc mixed", entry: { name: "x", SrcDoc: "<script>globalThis.__x=1</script>" }, expected: { name: "x" } },

  // ── rejected URL alongside otherwise-valid attributes ───────────────────
  {
    label: "rejected URL keeps its siblings",
    entry: { name: "x", content: "ok", id: "keep", HREF: XSS },
    expected: { name: "x", content: "ok", id: "keep" },
  },

  // ── entries that become completely empty ────────────────────────────────
  { label: "no attributes at all", entry: {}, expected: null },
  { label: "only an event handler", entry: { onload: "evil()" }, expected: null },
  { label: "only a rejected URL", entry: { href: XSS }, expected: null },
  { label: "only srcdoc", entry: { SRCDOC: "<script>1</script>" }, expected: null },
  { label: "only an invalid name", entry: { "1bad": "x" }, expected: null },

  // ── meta refresh ────────────────────────────────────────────────────────
  {
    label: "safe static refresh",
    entry: { "http-equiv": "refresh", content: "5;url=/home" },
    expected: { "http-equiv": "refresh", content: "5;url=/home" },
  },
  {
    label: "safe delay-only refresh",
    entry: { "http-equiv": "refresh", content: "30" },
    expected: { "http-equiv": "refresh", content: "30" },
  },
  {
    label: "cross-origin refresh",
    entry: { "http-equiv": "refresh", content: "5;url=https://other.example.com/landing" },
    expected: { "http-equiv": "refresh", content: "5;url=https://other.example.com/landing" },
  },
  {
    label: "mixed-case refresh spelling",
    entry: { "HTTP-EQUIV": "Refresh", CONTENT: "5;url=/home" },
    expected: { "http-equiv": "Refresh", content: "5;url=/home" },
  },
  { label: "forbidden refresh", entry: { "http-equiv": "refresh", content: `0;url=${XSS}` }, expected: null },
  {
    label: "forbidden refresh, spaced spelling",
    entry: { "http-equiv": "refresh", content: "0; URL = 'JaVaScRiPt:alert(1)'" },
    expected: null,
  },
  {
    label: "malformed refresh, unterminated quote",
    entry: { "http-equiv": "refresh", content: '0;url="/safe' },
    expected: null,
  },
  {
    label: "malformed refresh, competing assignments",
    entry: { "http-equiv": "refresh", content: "0;url=/safe;url=javascript:alert(1)" },
    expected: null,
  },
  {
    label: "malformed refresh, non-numeric delay",
    entry: { "http-equiv": "refresh", content: "abc;url=/safe" },
    expected: null,
  },
  {
    label: "refresh with a dangerous href sibling",
    entry: { "http-equiv": "refresh", content: "5;url=/home", HREF: XSS },
    expected: { "http-equiv": "refresh", content: "5;url=/home" },
  },
];

const component = () => div({ id: "app" }, "content") as HTMLElement;
const routes = [{ path: "/", component }];

function attrsOf(el: Element | null | undefined): Attrs {
  if (!el) return null;
  const out: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) out[a.name] = a.value;
  return out;
}

/** What the client publishes for one entry, read back off the live DOM. */
function clientResult(entry: Record<string, string>): Attrs {
  const head = Head({ meta: [entry] });
  try {
    return attrsOf(document.head.querySelector("meta"));
  } finally {
    dispose(head);
  }
}

/**
 * What a server path emits, parsed back through the SAME DOM the client is
 * measured with — so the comparison survives HTML canonicalization (entity
 * escaping, attribute-name folding) instead of comparing raw strings that could
 * differ for uninteresting reasons.
 */
function serverResult(html: string): Attrs {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const el = Array.from(doc.head.querySelectorAll("meta")).find(
    (m) => !m.hasAttribute("charset") && m.getAttribute("name") !== "viewport",
  );
  return attrsOf(el);
}

beforeEach(() => {
  for (const el of Array.from(document.head.querySelectorAll("meta,link,script"))) el.remove();
});

afterEach(() => {
  for (const el of Array.from(document.head.querySelectorAll("meta,link,script"))) el.remove();
});

describe("exact client / renderToDocument / router SSR parity", () => {
  for (const { label, entry, expected } of TABLE) {
    it(`agrees exactly on ${label}`, () => {
      const client = clientResult(entry);
      const doc = serverResult(renderToDocument(component, { meta: [entry] }));
      const routed = serverResult(renderRouteToDocument("/", routes, { meta: [entry] }));

      // 1. Every path matches the pinned expectation — catches a row all three
      //    get wrong in the same way.
      expect(client, "client").toEqual(expected);
      expect(doc, "renderToDocument").toEqual(expected);
      expect(routed, "router SSR").toEqual(expected);

      // 2. …and they match each other — catches drift the expectation happens
      //    not to distinguish.
      expect(doc, "renderToDocument diverged from the client").toEqual(client);
      expect(routed, "router SSR diverged from the client").toEqual(client);

      // 3. Emitted-or-not, attribute count, canonical names, and values, stated
      //    separately so a failure says which of them broke.
      const emitted = expected !== null;
      for (const [name, result] of [
        ["client", client],
        ["renderToDocument", doc],
        ["router SSR", routed],
      ] as const) {
        expect(result !== null, `${name} emitted-or-not`).toBe(emitted);
        if (!expected || !result) continue;
        expect(Object.keys(result).length, `${name} attribute count`).toBe(Object.keys(expected).length);
        expect(Object.keys(result).sort(), `${name} canonical names`).toEqual(Object.keys(expected).sort());
        for (const key of Object.keys(expected)) {
          expect(result[key], `${name} value of ${key}`).toBe(expected[key]);
        }
      }
    });
  }
});

describe("reactive refresh values are withheld — a client-only contract", () => {
  // This is the one place the three paths legitimately differ, and it is NOT a
  // URL-policy exception. Reactive values exist only on the client, and a
  // browser schedules a meta refresh when the element is INSERTED — removing it
  // afterwards is not a defined cancellation. So the client never publishes a
  // refresh from a reactive entry, while the servers, whose values are static
  // by construction, publish the same directive as before.
  for (const content of ["5;url=/home", "30", "5;url=https://other.example.com/landing"]) {
    it(`withholds ${JSON.stringify(content)} on the client and emits it statically`, () => {
      const [value] = signal(content);
      const head = Head({ meta: [{ "http-equiv": "refresh", content: () => value() }] });
      expect(attrsOf(document.head.querySelector("meta")), "a reactive refresh was published").toBeNull();
      dispose(head);

      const staticEntry = { "http-equiv": "refresh", content };
      const expected = { "http-equiv": "refresh", content };
      expect(clientResult(staticEntry), "the static equivalent was withheld").toEqual(expected);
      expect(serverResult(renderToDocument(component, { meta: [staticEntry] }))).toEqual(expected);
      expect(serverResult(renderRouteToDocument("/", routes, { meta: [staticEntry] }))).toEqual(expected);
    });
  }

  it("does not withhold a reactive NON-refresh entry", () => {
    const [desc] = signal("hello");
    const head = Head({ meta: [{ name: "description", content: () => desc() }] });
    expect(attrsOf(document.head.querySelector("meta"))).toEqual({ name: "description", content: "hello" });
    dispose(head);
  });

  it("applies the identical URL policy to reactive values", () => {
    // The reactive contract withholds refresh directives; it does not relax
    // anything about URL attributes.
    const [url] = signal(XSS);
    const head = Head({ meta: [{ name: "x", HREF: () => url() }] });
    expect(attrsOf(document.head.querySelector("meta"))).toEqual({ name: "x" });
    dispose(head);
  });
});

describe("link entries agree between the client and both servers", () => {
  const LINK_ROWS: Row[] = [
    {
      label: "safe stylesheet",
      entry: { rel: "stylesheet", href: "/a.css" },
      expected: { rel: "stylesheet", href: "/a.css" },
    },
    {
      label: "mixed-case HREF, safe",
      entry: { rel: "stylesheet", HREF: "/a.css" },
      expected: { rel: "stylesheet", href: "/a.css" },
    },
    { label: "mixed-case HREF, dangerous", entry: { rel: "stylesheet", HREF: XSS }, expected: { rel: "stylesheet" } },
    { label: "file: scheme", entry: { rel: "icon", href: "file:///etc/passwd" }, expected: { rel: "icon" } },
    { label: "srcdoc in any casing", entry: { rel: "icon", SRCDOC: "<script>1</script>" }, expected: { rel: "icon" } },
    { label: "duplicate rel casing", entry: { rel: "a", REL: "b" }, expected: null },
    { label: "entry that becomes empty", entry: { href: XSS }, expected: null },
  ];

  function clientLink(entry: Record<string, string>): Attrs {
    const head = Head({ link: [entry] });
    try {
      return attrsOf(document.head.querySelector("link"));
    } finally {
      dispose(head);
    }
  }

  function serverLink(html: string): Attrs {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return attrsOf(doc.head.querySelector("link"));
  }

  for (const { label, entry, expected } of LINK_ROWS) {
    it(`agrees exactly on ${label}`, () => {
      const client = clientLink(entry);
      const doc = serverLink(renderToDocument(component, { links: [entry] }));
      const routed = serverLink(renderRouteToDocument("/", routes, { links: [entry] }));

      expect(client, "client").toEqual(expected);
      expect(doc, "renderToDocument").toEqual(expected);
      expect(routed, "router SSR").toEqual(expected);
    });
  }
});

describe("script src agrees between the client and both servers", () => {
  // The SSR option is `scripts: string[]` (a bare src list) rather than an
  // attribute record, so the comparable unit is the resulting `src`.
  function clientScriptSrc(src: string): string | null {
    const head = Head({ script: [{ src }] });
    try {
      const el = document.head.querySelector("script");
      return el ? (el.getAttribute("src") ?? null) : null;
    } finally {
      dispose(head);
    }
  }

  function serverScriptSrc(html: string): string | null {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const el = doc.querySelector("script[src]");
    return el ? el.getAttribute("src") : null;
  }

  for (const [label, src, expected] of [
    ["safe relative", "/app.js", "/app.js"],
    ["safe absolute", "https://cdn.example.com/app.js", "https://cdn.example.com/app.js"],
    ["javascript:", XSS, null],
    ["data:", "data:text/javascript,globalThis.__x=1", null],
    ["file:", "file:///etc/passwd", null],
    ["unknown scheme", "custom-scheme:payload", null],
  ] as [string, string, string | null][]) {
    it(`agrees on ${label}`, () => {
      expect(clientScriptSrc(src), "client").toBe(expected);
      expect(serverScriptSrc(renderToDocument(component, { scripts: [src] })), "renderToDocument").toBe(expected);
      expect(serverScriptSrc(renderRouteToDocument("/", routes, { scripts: [src] })), "router SSR").toBe(expected);
    });
  }
});
