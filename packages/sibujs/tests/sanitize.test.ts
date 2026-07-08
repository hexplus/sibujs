import { describe, expect, it } from "vitest";
import {
  isSafeAttribute,
  isUrlAttribute,
  sanitize,
  sanitizeSrcset,
  sanitizeUrl,
  stripHtml,
} from "@sibujs/core/internal";

describe("sanitize", () => {
  it("should escape HTML entities", () => {
    expect(sanitize('<script>alert("xss")</script>')).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  });

  it("should escape ampersands", () => {
    expect(sanitize("a & b")).toBe("a &amp; b");
  });

  it("should escape single quotes", () => {
    expect(sanitize("it's")).toBe("it&#39;s");
  });
});

describe("sanitizeUrl", () => {
  it("should allow http and https URLs", () => {
    expect(sanitizeUrl("https://example.com")).toBe("https://example.com");
    expect(sanitizeUrl("http://example.com")).toBe("http://example.com");
  });

  it("should block javascript: protocol", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBe("");
    expect(sanitizeUrl("JAVASCRIPT:alert(1)")).toBe("");
  });

  it("should block data: protocol", () => {
    expect(sanitizeUrl("data:text/html,<script>")).toBe("");
  });

  it("should block vbscript: protocol", () => {
    expect(sanitizeUrl("vbscript:MsgBox")).toBe("");
  });

  it("should allow relative URLs", () => {
    expect(sanitizeUrl("/path/to/page")).toBe("/path/to/page");
    expect(sanitizeUrl("./relative")).toBe("./relative");
  });

  it("should return empty for empty input", () => {
    expect(sanitizeUrl("")).toBe("");
    expect(sanitizeUrl("   ")).toBe("");
  });

  it("should block javascript: with leading control characters", () => {
    expect(sanitizeUrl("\x00javascript:alert(1)")).toBe("");
    expect(sanitizeUrl("\x01javascript:alert(1)")).toBe("");
    expect(sanitizeUrl("\x0Bjavascript:alert(1)")).toBe("");
    expect(sanitizeUrl("\x1Fjavascript:alert(1)")).toBe("");
  });

  it("should block data: with embedded control characters", () => {
    expect(sanitizeUrl("\x00data:text/html,<script>")).toBe("");
  });
});

describe("stripHtml", () => {
  it("should remove all HTML tags", () => {
    expect(stripHtml("<b>bold</b> and <em>italic</em>")).toBe("bold and italic");
  });

  it("should handle nested tags", () => {
    expect(stripHtml("<div><p>text</p></div>")).toBe("text");
  });

  it("neutralizes a nested-tag bypass that a naive regex leaves dangerous", () => {
    // A single-pass /<[^>]*>/ leaves "ipt>alert(1)" with a live <script>.
    const out = stripHtml("<scr<script>ipt>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out.toLowerCase()).not.toContain("<scr");
  });

  it("neutralizes an unclosed tag with an event handler", () => {
    // No closing ">" — a naive regex passes it through verbatim.
    const out = stripHtml('<img src="x" onerror="alert(1)"');
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("<img");
  });

  it("returns text content for ordinary markup", () => {
    expect(stripHtml("<a href='/x'>link</a>")).toBe("link");
  });
});

describe("isSafeAttribute", () => {
  it("should recognize safe attributes", () => {
    expect(isSafeAttribute("id")).toBe(true);
    expect(isSafeAttribute("class")).toBe(true);
    expect(isSafeAttribute("data-custom")).toBe(true);
    expect(isSafeAttribute("aria-label")).toBe(true);
  });
});

describe("isUrlAttribute", () => {
  it("should recognize URL attributes", () => {
    expect(isUrlAttribute("href")).toBe(true);
    expect(isUrlAttribute("src")).toBe(true);
    expect(isUrlAttribute("action")).toBe(true);
  });

  it("should not flag non-URL attributes", () => {
    expect(isUrlAttribute("class")).toBe(false);
    expect(isUrlAttribute("id")).toBe(false);
  });

  it("should be case-insensitive (HTML attribute names are)", () => {
    expect(isUrlAttribute("HREF")).toBe(true);
    expect(isUrlAttribute("Href")).toBe(true);
    expect(isUrlAttribute("SRC")).toBe(true);
    expect(isUrlAttribute("XLINK:HREF")).toBe(true);
  });
});

describe("sanitizeSrcset", () => {
  it("drops candidates with dangerous schemes but keeps safe ones", () => {
    const out = sanitizeSrcset("a.jpg 1x, javascript:alert(1) 2x, https://cdn/b.jpg 3x");
    expect(out).toContain("a.jpg 1x");
    expect(out).toContain("https://cdn/b.jpg 3x");
    expect(out).not.toContain("javascript:");
  });

  it("does not pass a multi-candidate list through unchanged (the sanitizeUrl bug)", () => {
    // sanitizeUrl would return the whole list verbatim; sanitizeSrcset must not.
    const malicious = "x 1x, javascript:alert(1) 2x";
    expect(sanitizeSrcset(malicious)).not.toContain("javascript:");
  });
});
