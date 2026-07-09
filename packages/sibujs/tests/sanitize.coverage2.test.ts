import {
  isSafeAttribute,
  isUrlAttribute,
  sanitizeAttribute,
  sanitizeCSSValue,
  sanitizeSrcset,
  sanitizeUrl,
  stripHtml,
} from "@sibujs/core/internal";
import { describe, expect, it } from "vitest";

describe("sanitizeUrl (coverage2)", () => {
  it("returns empty for whitespace-only / control-only input", () => {
    expect(sanitizeUrl("   ")).toBe("");
    expect(sanitizeUrl("\x00\x01\x02")).toBe("");
  });

  it("allows safe protocols and relative URLs", () => {
    expect(sanitizeUrl("https://example.com")).toBe("https://example.com");
    expect(sanitizeUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(sanitizeUrl("/relative/path")).toBe("/relative/path");
    expect(sanitizeUrl("page?q=1")).toBe("page?q=1");
    expect(sanitizeUrl("#anchor")).toBe("#anchor");
  });

  it("rejects dangerous protocols, including obfuscated ones", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBe("");
    expect(sanitizeUrl("java\tscript:alert(1)")).toBe("");
    expect(sanitizeUrl("\x01javascript:alert(1)")).toBe("");
    expect(sanitizeUrl("data:text/html,<script>")).toBe("");
  });

  it("treats colon inside a path as a relative URL, not a scheme", () => {
    // The ":" appears after a "/" so it is not a scheme
    expect(sanitizeUrl("/path:with:colons")).toBe("/path:with:colons");
    // A "scheme" containing an invalid char (underscore) is not a real scheme,
    // so the ":" is part of a relative path and the value is kept.
    expect(sanitizeUrl("foo_bar:baz")).toBe("foo_bar:baz");
  });
});

describe("sanitizeSrcset (coverage2)", () => {
  it("keeps safe candidates with descriptors and drops unsafe ones", () => {
    const out = sanitizeSrcset("/a.png 1x, https://x/b.png 2x, javascript:alert(1) 3x");
    expect(out).toContain("/a.png 1x");
    expect(out).toContain("https://x/b.png 2x");
    expect(out).not.toContain("javascript");
  });

  it("skips empty parts and unmatched candidates", () => {
    const out = sanitizeSrcset(",  , /only.png");
    expect(out).toBe("/only.png");
  });

  it("handles a candidate without a descriptor", () => {
    expect(sanitizeSrcset("/single.png")).toBe("/single.png");
  });

  it("drops a candidate whose url is unsafe", () => {
    expect(sanitizeSrcset("javascript:evil 1x")).toBe("");
  });
});

describe("sanitizeCSSValue (coverage2)", () => {
  it("returns safe values unchanged", () => {
    expect(sanitizeCSSValue("12px")).toBe("12px");
    expect(sanitizeCSSValue("rgb(0,0,0)")).toBe("rgb(0,0,0)");
  });

  it("strips url()", () => {
    expect(sanitizeCSSValue("url(http://evil)")).toBe("");
  });

  it("strips expression()", () => {
    expect(sanitizeCSSValue("expression(alert(1))")).toBe("");
  });

  it("strips javascript: / vbscript:", () => {
    expect(sanitizeCSSValue("javascript:alert(1)")).toBe("");
    expect(sanitizeCSSValue("vbscript:msgbox")).toBe("");
  });

  it("strips -moz-binding, behavior, @import, image-set, filter:progid", () => {
    expect(sanitizeCSSValue("-moz-binding: url(x)")).toBe("");
    expect(sanitizeCSSValue("behavior: url(x)")).toBe("");
    expect(sanitizeCSSValue("@import url(x)")).toBe("");
    expect(sanitizeCSSValue("image-set('a' 1x)")).toBe("");
    expect(sanitizeCSSValue("filter:progid:DXImageTransform")).toBe("");
  });

  it("decodes CSS hex escapes before checking (bypass attempt)", () => {
    // "\\75 rl(" decodes to "url("
    expect(sanitizeCSSValue("\\75 rl(http://evil)")).toBe("");
    // "ex\\70 ression(" decodes to "expression("
    expect(sanitizeCSSValue("ex\\70 ression(alert(1))")).toBe("");
  });

  it("handles out-of-range / invalid code points in escape decoding", () => {
    // Code point above 0x10FFFF -> replaced with empty during decode, value stays safe text
    const out = sanitizeCSSValue("\\110000 abc");
    expect(typeof out).toBe("string");
  });
});

describe("stripHtml (coverage2)", () => {
  it("strips tags using the DOM parser path", () => {
    expect(stripHtml("<b>hi</b>")).toBe("hi");
    expect(stripHtml("<scr<script>ipt>alert(1)</script>")).not.toContain("<script");
  });

  it("uses the no-DOM regex fallback when DOMParser is undefined", () => {
    const original = globalThis.DOMParser;
    // @ts-expect-error intentionally removing for the fallback path
    globalThis.DOMParser = undefined;
    try {
      // The loop runs until stable; here one pass removes <scr...> and <script>
      // leaving stray "ipt>" text, but crucially no live tag remains.
      const nested = stripHtml("<scr<script>ipt>x</script>");
      expect(nested).not.toContain("<script");
      expect(nested).toContain("x");
      // Dangling unclosed tag start is dropped
      expect(stripHtml("text<img onerror=alert(1)")).toBe("text");
      expect(stripHtml("<b>bold</b> plain")).toBe("bold plain");
    } finally {
      globalThis.DOMParser = original;
    }
  });

  it("falls back to regex if DOMParser throws", () => {
    const original = globalThis.DOMParser;
    class ThrowingParser {
      parseFromString(): never {
        throw new Error("boom");
      }
    }
    // @ts-expect-error swap in a throwing parser
    globalThis.DOMParser = ThrowingParser;
    try {
      expect(stripHtml("<b>hi</b>")).toBe("hi");
    } finally {
      globalThis.DOMParser = original;
    }
  });
});

describe("attribute helpers (coverage2)", () => {
  it("isSafeAttribute recognizes allowlist, data-, and aria-", () => {
    expect(isSafeAttribute("id")).toBe(true);
    expect(isSafeAttribute("data-foo")).toBe(true);
    expect(isSafeAttribute("aria-custom")).toBe(true);
    expect(isSafeAttribute("onclick")).toBe(false);
    expect(isSafeAttribute("style")).toBe(true);
  });

  it("isUrlAttribute is case-insensitive", () => {
    expect(isUrlAttribute("HREF")).toBe(true);
    expect(isUrlAttribute("xlink:HREF")).toBe(true);
    expect(isUrlAttribute("title")).toBe(false);
  });

  it("sanitizeAttribute applies URL sanitization for URL attrs", () => {
    expect(sanitizeAttribute("href", "javascript:alert(1)")).toBe("");
    expect(sanitizeAttribute("href", "https://ok")).toBe("https://ok");
  });

  it("sanitizeAttribute escapes HTML for non-URL attrs", () => {
    expect(sanitizeAttribute("title", '<a>"&')).toBe("&lt;a&gt;&quot;&amp;");
  });
});
