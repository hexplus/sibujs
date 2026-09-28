/**
 * The URL policy, checked against the BROWSER'S reading of the same string.
 *
 * `sanitizeUrl` decides on a conservative PROBE (every character a browser
 * might ignore removed) and returns the author's value minus only the outer
 * padding. The property that matters is not "the probe looks safe" but:
 *
 *     whatever the framework lets through, the WHATWG URL parser — the one every
 *     supported browser runs on an attribute value — resolves to an allowed
 *     scheme.
 *
 * That is asserted here directly against a WHATWG `URL` implementation, for a
 * hand-written table of known bypass spellings and for a seeded fuzz corpus of
 * mutations (case flips, C0/C1 controls, Unicode whitespace, entity and
 * percent encodings, backslashes, doubled encodings). `tests-browser/` repeats
 * the ambiguous cases in real engines.
 *
 * The sanitizer must NOT decode what the browser does not decode: entities are
 * only decoded by the HTML parser, never by `setAttribute`, and percent-escapes
 * never form a scheme. So `&#106;avascript:` and `%6a%61…:` are RELATIVE URLs,
 * and treating them as `javascript:` would be the over-decoding that makes a
 * sanitizer and a browser disagree.
 */

import { describe, expect, it } from "vitest";
import { html } from "../src/core/rendering/htm";
import { a, img } from "../src/core/rendering/html";
import { renderToString } from "../src/platform/ssr";
import { sanitizeSrcset, sanitizeUrl } from "../src/utils/sanitize";

const BASE = "https://app.example/base/page";
const ALLOWED = new Set(["http:", "https:", "mailto:", "tel:", "ftp:"]);

/** The scheme a browser would resolve this attribute value to. */
function browserScheme(value: string): string | null {
  try {
    return new URL(value, BASE).protocol;
  } catch {
    return null; // unparseable: the browser treats the link as inert
  }
}

function assertBrowserSafe(input: string): void {
  const kept = sanitizeUrl(input);
  if (kept === "") return;
  const scheme = browserScheme(kept);
  if (scheme !== null && !ALLOWED.has(scheme)) {
    throw new Error(`sanitizeUrl kept ${JSON.stringify(input)} → ${JSON.stringify(kept)}, which resolves to ${scheme}`);
  }
}

// ─── known spellings ────────────────────────────────────────────────────────

const REFUSED: string[] = [
  "javascript:alert(1)",
  "JAVASCRIPT:alert(1)",
  " javaScript:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "java\rscript:alert(1)",
  "java\u0000script:alert(1)",
  "\u0000javascript:alert(1)",
  "\u0001\u0002javascript:alert(1)",
  "\u001fjavascript:alert(1)",
  "javascript\t:alert(1)",
  "\u0085javascript:alert(1)",
  "\u009fjavascript:alert(1)",
  "\u00a0javascript:alert(1)",
  "\ufeffjavascript:alert(1)",
  "javascript:alert(1)\u0000",
  "data:text/html,<script>alert(1)</script>",
  "DATA:text/html;base64,PHNjcmlwdD4=",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "blob:https://app.example/uuid",
  "about:blank",
  "chrome://settings",
  "filesystem:https://app.example/temporary/x",
  "jar:https://x!/y",
  "intent://scan/#Intent;scheme=zxing;end",
  "ws://app.example/socket",
  // A leading slash pair containing a backslash. WHATWG reads it as
  // protocol-relative, but Chromium on Windows resolves `\\host\share` as a
  // UNC path, i.e. `file:` — found by tests-browser/contextual-policy-security.
  "\\\\evil.example\\x",
  "\\/evil.example/x",
  "/\\evil.example/x",
  "\t\\\\evil.example\\x",
];

const KEPT_RELATIVE_OR_SAFE: [string, string][] = [
  // Entities are decoded by the HTML PARSER only. Through setAttribute this is
  // literally `&#106;avascript:…`, a relative path with a fragment.
  ["&#106;avascript:alert(1)", "https:"],
  ["jav&#x61;script:alert(1)", "https:"],
  ["javascript&colon;alert(1)", "https:"],
  // Percent-escapes never form a scheme: `%` is not a scheme character.
  ["%6a%61%76%61%73%63%72%69%70%74:alert(1)", "https:"],
  ["%256a%2561vascript:alert(1)", "https:"],
  // Protocol-relative inherits the page's (allowed) scheme.
  ["//evil.example/x", "https:"],
  ["/path\\with\\backslashes", "https:"],
  ["https://example.com/a b", "https:"],
  ["mailto:a@b.example?subject=Hello World", "mailto:"],
  ["tel:+1-555-0100", "tel:"],
  ["ftp://files.example/x", "ftp:"],
  ["?q=javascript:alert(1)", "https:"],
  ["#javascript:alert(1)", "https:"],
  ["./javascript:alert(1)", "https:"],
];

describe("sanitizeUrl — known bypass spellings", () => {
  for (const input of REFUSED) {
    it(`refuses ${JSON.stringify(input)}`, () => {
      expect(sanitizeUrl(input)).toBe("");
    });
  }

  for (const [input, scheme] of KEPT_RELATIVE_OR_SAFE) {
    it(`keeps ${JSON.stringify(input)} (browser resolves it to ${scheme})`, () => {
      const kept = sanitizeUrl(input);
      expect(kept).not.toBe("");
      expect(browserScheme(kept)).toBe(scheme);
    });
  }

  it("never rewrites the interior of a kept value (no over-decoding, no corruption)", () => {
    expect(sanitizeUrl("&#106;avascript:alert(1)")).toBe("&#106;avascript:alert(1)");
    expect(sanitizeUrl("%6a%61va:x")).toBe("%6a%61va:x");
    expect(sanitizeUrl("\u0001 /path?q=a b \u0002")).toBe("/path?q=a b");
  });
});

// ─── seeded fuzz ────────────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32) — a failure must be reproducible. */
function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const SCHEMES = [
  "javascript",
  "data",
  "vbscript",
  "file",
  "blob",
  "about",
  "http",
  "https",
  "mailto",
  "tel",
  "ftp",
  "x",
];
const NOISE = [
  "\t",
  "\n",
  "\r",
  "\u0000",
  "\u0001",
  "\u001f",
  " ",
  "\u007f",
  "\u0080",
  "\u0085",
  "\u009f",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u200b",
  "\u2028",
  "\u3000",
  "\ufeff",
  "%",
  "%0a",
  "&#",
  "&#x09;",
  "\\",
  "/",
  "//",
  ":",
  "#",
  "?",
  "@",
];
const PREFIXES = ["", "", "", " ", "\u0001", "\u0000\t", "//", "\\\\", "/", "\u00a0", "\ufeff", "\u0085"];

function mutate(next: () => number): string {
  const pick = <T>(list: T[]): T => list[Math.floor(next() * list.length)];
  let scheme = pick(SCHEMES)
    .split("")
    .map((ch) => (next() < 0.5 ? ch.toUpperCase() : ch))
    .join("");
  const insertions = Math.floor(next() * 3);
  for (let i = 0; i < insertions; i++) {
    const at = Math.floor(next() * (scheme.length + 1));
    scheme = scheme.slice(0, at) + pick(NOISE) + scheme.slice(at);
  }
  const separator = next() < 0.85 ? ":" : pick(["&colon;", "%3a", "\t:", ":\u0000"]);
  return `${pick(PREFIXES)}${scheme}${separator}${pick(["alert(1)", "//host/x", "text/html,<script>x</script>", ""])}${
    next() < 0.2 ? pick(NOISE) : ""
  }`;
}

describe("sanitizeUrl — seeded fuzz against the WHATWG URL parser", () => {
  it("everything it keeps resolves to an allowed scheme (10 000 mutations)", () => {
    const next = rng(0x5eed);
    for (let i = 0; i < 10_000; i++) assertBrowserSafe(mutate(next));
  });

  it("every attribute writer keeps only what the parser resolves safely", () => {
    const next = rng(0xbeef);
    for (let i = 0; i < 1_000; i++) {
      const input = mutate(next);
      const viaFactory = a({ href: input }).getAttribute("href");
      const viaTemplate = html`<a href=${input}></a>`.getAttribute("href");
      for (const kept of [viaFactory, viaTemplate]) {
        if (kept === null) continue;
        const scheme = browserScheme(kept);
        expect(scheme === null || ALLOWED.has(scheme), `${JSON.stringify(input)} → ${JSON.stringify(kept)}`).toBe(true);
      }
      // SSR parity: what the server emits is what the client committed — up
      // to the HTML parser's own input normalization (U+0000 becomes U+FFFD,
      // CR / CRLF become LF), which applies to any serialized attribute.
      const ssr = new DOMParser()
        .parseFromString(renderToString(a({ href: input })), "text/html")
        .querySelector("a")
        ?.getAttribute("href");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: U+0000 is exactly what the HTML parser rewrites
      const parserNormalized = viaFactory?.replace(/\u0000/g, "\ufffd").replace(/\r\n?/g, "\n") ?? null;
      expect(ssr ?? null).toBe(parserNormalized);
    }
  });
});

// ─── srcset ─────────────────────────────────────────────────────────────────

describe("sanitizeSrcset — every surviving candidate resolves safely", () => {
  it("drops obfuscated candidates hiding in descriptor whitespace", () => {
    expect(sanitizeSrcset("java\tscript:alert(1) 1x")).toBe("");
    expect(sanitizeSrcset("/a.png 1x, java\nscript:alert(1) 2x, /b.png 640w")).toBe("/a.png 1x, /b.png 640w");
    expect(sanitizeSrcset("data:image/svg+xml,x 1x, /ok.png")).toBe("/ok.png");
  });

  it("fuzz: no kept candidate resolves to a disallowed scheme", () => {
    const next = rng(0xc0ffee);
    for (let i = 0; i < 3_000; i++) {
      const list = [mutate(next), mutate(next), "/safe.png"].map((u, j) => `${u} ${j + 1}x`).join(", ");
      for (const candidate of sanitizeSrcset(list).split(", ").filter(Boolean)) {
        const url = candidate.replace(/\s+\d+(\.\d+)?[wx]$/, "");
        const scheme = browserScheme(url);
        expect(scheme === null || ALLOWED.has(scheme), `${JSON.stringify(list)} kept ${candidate}`).toBe(true);
      }
    }
  });

  it("tokenizes like the browser: commas inside a URL do not split it", () => {
    expect(sanitizeSrcset("https://cdn.example/i.jpg?w=100,h=200 2x, /b.png 640w")).toBe(
      "https://cdn.example/i.jpg?w=100,h=200 2x, /b.png 640w",
    );
    expect(sanitizeSrcset("/a.png,/b.png 2x")).toBe("/a.png,/b.png 2x");
    expect(sanitizeSrcset("/a.png, /b.png 2x")).toBe("/a.png, /b.png 2x");
    expect(sanitizeSrcset("/a.png,, ,/b.png")).toBe("/a.png, /b.png");
    // A descriptor list the strict reading cannot confirm is dropped.
    expect(sanitizeSrcset("/a.png 1x 2x, /b.png 100w 50h, /c.png 1e0x")).toBe("");
  });

  it("the srcset policy is the same on every writer", () => {
    const value = "/a.png 1x, javascript:alert(1) 2x";
    expect(img({ srcset: value }).getAttribute("srcset")).toBe("/a.png 1x");
    expect(html`<img srcset=${value}>`.getAttribute("srcset")).toBe("/a.png 1x");
  });
});

describe("authored empty values are not refusals on live elements", () => {
  it('a({ href: "" }) stays a focusable self-link; a refused value is removed', () => {
    expect(a({ href: "" }).getAttribute("href")).toBe("");
    expect(html`<a href=${""}></a>`.getAttribute("href")).toBe("");
    expect(a({ href: "javascript:alert(1)" }).hasAttribute("href")).toBe(false);
    expect(a({ href: " \t" }).hasAttribute("href")).toBe(false);
  });
});
