import { describe, expect, it } from "vitest";
import { sanitizeAttributeString, sanitizeSrcset, sanitizeUrl } from "../src/utils/sanitize";

// ---------------------------------------------------------------------------
// URL sanitizer: security normalization vs output normalization.
//
// THE INVARIANT UNDER TEST: the aggressively stripped copy used to DETECT an
// obfuscated scheme must not be the value returned to the caller.
//
// Regression origin: `sanitizeUrl` stripped every ASCII whitespace and control
// character (so "java\tscript:" could not slip past the allowlist) and then
// returned that stripped string — silently rewriting legitimate URLs, e.g.
// "mailto:a@b.com?subject=Hello World" became "...HelloWorld".
//
// Security still takes precedence: anything the probe reads as a disallowed
// scheme is rejected, whatever the raw input would have parsed as.
// ---------------------------------------------------------------------------

describe("sanitizeUrl — blocks dangerous schemes", () => {
  it("blocks plain javascript:", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBe("");
  });

  it("blocks mixed-case schemes", () => {
    expect(sanitizeUrl("JAVASCRIPT:alert(1)")).toBe("");
    expect(sanitizeUrl("JaVaScRiPt:alert(1)")).toBe("");
    expect(sanitizeUrl("VBScript:MsgBox")).toBe("");
  });

  it("blocks schemes obfuscated with interior control characters", () => {
    expect(sanitizeUrl("java\tscript:alert(1)")).toBe("");
    expect(sanitizeUrl("java\nscript:alert(1)")).toBe("");
    expect(sanitizeUrl("java\r\nscript:alert(1)")).toBe("");
    expect(sanitizeUrl("j\x00a\x01v\x02ascript:alert(1)")).toBe("");
  });

  it("blocks schemes obfuscated with leading control characters", () => {
    expect(sanitizeUrl("\x01javascript:alert(1)")).toBe("");
    expect(sanitizeUrl("\x00\x1fjavascript:alert(1)")).toBe("");
    expect(sanitizeUrl("  \t javascript:alert(1)")).toBe("");
  });

  it("blocks other non-allowlisted schemes", () => {
    expect(sanitizeUrl("data:text/html,<script>")).toBe("");
    expect(sanitizeUrl("vbscript:MsgBox")).toBe("");
    expect(sanitizeUrl("blob:https://evil.example/x")).toBe("");
    expect(sanitizeUrl("file:///etc/passwd")).toBe("");
  });

  it("rejects a whitespace-obfuscated scheme even though the raw string differs", () => {
    // Raw "ja vascript:x" has no valid scheme, but the probe reads it as
    // javascript: — security wins over preservation.
    expect(sanitizeUrl("ja vascript:alert(1)")).toBe("");
  });

  it("returns empty for blank or control-only input", () => {
    expect(sanitizeUrl("")).toBe("");
    expect(sanitizeUrl("   ")).toBe("");
    expect(sanitizeUrl("\x00\x01\x02")).toBe("");
  });
});

describe("sanitizeUrl — preserves legitimate values", () => {
  it("returns simple safe URLs unchanged", () => {
    expect(sanitizeUrl("https://example.com")).toBe("https://example.com");
    expect(sanitizeUrl("http://example.com")).toBe("http://example.com");
    expect(sanitizeUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
    expect(sanitizeUrl("tel:+15551234")).toBe("tel:+15551234");
    expect(sanitizeUrl("ftp://files.example.com/x")).toBe("ftp://files.example.com/x");
  });

  it("preserves interior spaces instead of silently deleting them", () => {
    expect(sanitizeUrl("https://example.com/a b")).toBe("https://example.com/a b");
    expect(sanitizeUrl("https://example.com/search?q=hello world")).toBe("https://example.com/search?q=hello world");
  });

  it("preserves a mailto subject, which stripping would corrupt", () => {
    expect(sanitizeUrl("mailto:a@b.com?subject=Hello World")).toBe("mailto:a@b.com?subject=Hello World");
    expect(sanitizeUrl("mailto:a@b.com?body=Line one and two")).toBe("mailto:a@b.com?body=Line one and two");
  });

  it("preserves relative URLs including spaces", () => {
    expect(sanitizeUrl("/relative/path")).toBe("/relative/path");
    expect(sanitizeUrl("./relative")).toBe("./relative");
    expect(sanitizeUrl("page?q=1")).toBe("page?q=1");
    expect(sanitizeUrl("#anchor")).toBe("#anchor");
    expect(sanitizeUrl("/my folder/file.txt")).toBe("/my folder/file.txt");
  });

  it("trims only the outer padding", () => {
    expect(sanitizeUrl("  https://example.com  ")).toBe("https://example.com");
    expect(sanitizeUrl("\n\thttps://example.com\n")).toBe("https://example.com");
  });

  it("leaves colon-bearing relative paths alone", () => {
    expect(sanitizeUrl("/path:with:colons")).toBe("/path:with:colons");
    expect(sanitizeUrl("foo_bar:baz")).toBe("foo_bar:baz");
  });

  it("preserves query strings that encode structured data", () => {
    const url = "https://example.com/api?filter=name eq 'John Smith'&limit=10";
    expect(sanitizeUrl(url)).toBe(url);
  });
});

describe("sanitizeSrcset", () => {
  it("keeps descriptors and drops dangerous candidates", () => {
    expect(sanitizeSrcset("a.png 1x, b.png 2x")).toBe("a.png 1x, b.png 2x");
    expect(sanitizeSrcset("javascript:alert(1) 1x, ok.png 2x")).toBe("ok.png 2x");
  });

  it("drops a candidate whose scheme is obfuscated", () => {
    expect(sanitizeSrcset("java\tscript:alert(1) 1x, ok.png 2x")).toBe("ok.png 2x");
  });
});

describe("sanitizeAttributeString routing", () => {
  it("applies URL policy to URL attributes, case-insensitively", () => {
    expect(sanitizeAttributeString("href", "javascript:alert(1)")).toBe("");
    expect(sanitizeAttributeString("HREF", "javascript:alert(1)")).toBe("");
    expect(sanitizeAttributeString("xlink:href", "javascript:alert(1)")).toBe("");
    expect(sanitizeAttributeString("href", "https://example.com/a b")).toBe("https://example.com/a b");
  });

  it("applies srcset policy to srcset", () => {
    expect(sanitizeAttributeString("srcset", "javascript:alert(1) 1x, ok.png 2x")).toBe("ok.png 2x");
  });

  it("passes non-URL attributes through untouched", () => {
    expect(sanitizeAttributeString("title", "a < b & c")).toBe("a < b & c");
  });
});
