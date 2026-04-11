// ============================================================================
// Head / setStructuredData / setCanonical — security tests
// ============================================================================

import { beforeEach, describe, expect, it } from "vitest";
import { Head, setCanonical, setStructuredData } from "../src/platform/head";

function cleanHead() {
  for (const el of document.head.querySelectorAll("meta")) el.remove();
  for (const el of document.head.querySelectorAll("link")) el.remove();
  for (const el of document.head.querySelectorAll("script")) el.remove();
  for (const el of document.head.querySelectorAll("base")) el.remove();
}

describe("Head / base tag — javascript: href", () => {
  beforeEach(cleanHead);

  it("drops javascript: base href", () => {
    Head({ base: { href: "javascript:alert(1)" } });
    const base = document.head.querySelector("base");
    expect(base).not.toBeNull();
    // The href attribute must not carry the javascript: protocol.
    expect(base?.getAttribute("href") ?? "").not.toContain("javascript");
  });

  it("accepts safe base href", () => {
    Head({ base: { href: "https://example.com/" } });
    const base = document.head.querySelector("base");
    expect(base?.href).toContain("https://example.com/");
  });
});

describe("Head / meta http-equiv refresh", () => {
  beforeEach(cleanHead);

  it("drops http-equiv=refresh with javascript: URL", () => {
    Head({
      meta: [
        { "http-equiv": "refresh", content: "0;url=javascript:alert(1)" },
        { name: "description", content: "Still here" },
      ],
    });
    // The refresh entry must be dropped entirely.
    expect(document.head.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    // Legitimate meta tags remain.
    expect(document.head.querySelector('meta[name="description"]')).not.toBeNull();
  });

  it("keeps http-equiv=refresh with a safe URL", () => {
    Head({ meta: [{ "http-equiv": "refresh", content: "5;url=/home" }] });
    expect(document.head.querySelector('meta[http-equiv="refresh"]')).not.toBeNull();
  });

  it("drops data: URLs in refresh content", () => {
    Head({ meta: [{ "http-equiv": "refresh", content: "0;url=data:text/html,<svg/onload=alert(1)>" }] });
    expect(document.head.querySelector('meta[http-equiv="refresh"]')).toBeNull();
  });
});

describe("Head / meta — event-handler key rejection", () => {
  beforeEach(cleanHead);

  it("drops onload/onerror attribute keys on meta", () => {
    const hostile: Record<string, string> = {
      onload: "alert(1)",
      name: "keep",
      content: "value",
    };
    Head({ meta: [hostile] });
    const meta = document.head.querySelector('meta[name="keep"]');
    expect(meta).not.toBeNull();
    expect(meta?.getAttributeNames()).not.toContain("onload");
  });
});

describe("Head / link — href sanitization", () => {
  beforeEach(cleanHead);

  it("strips javascript: href on link tags", () => {
    Head({ link: [{ rel: "icon", href: "javascript:alert(1)" }] });
    const link = document.head.querySelector('link[rel="icon"]');
    expect(link?.getAttribute("href") ?? "").not.toContain("javascript");
  });
});

describe("setStructuredData — script-tag escaping", () => {
  beforeEach(cleanHead);

  it("escapes < and > in JSON text", () => {
    setStructuredData({ "@type": "WebPage", name: "</script><script>alert(1)</script>" });
    const script = document.head.querySelector('script[type="application/ld+json"]');
    const text = script?.textContent ?? "";
    expect(text).not.toMatch(/<\/script>[^<]*<script/);
    expect(text).toContain("\\u003c");
  });

  it("escapes U+2028 and U+2029", () => {
    setStructuredData({ a: "x\u2028y\u2029z" });
    const script = document.head.querySelector('script[type="application/ld+json"]');
    const text = script?.textContent ?? "";
    expect(text).toContain("\\u2028");
    expect(text).toContain("\\u2029");
  });
});

describe("setCanonical — URL sanitization", () => {
  beforeEach(cleanHead);

  it("drops javascript: canonical URL", () => {
    setCanonical("javascript:alert(1)");
    const link = document.head.querySelector('link[rel="canonical"]');
    expect(link?.getAttribute("href") ?? "").not.toContain("javascript");
  });

  it("accepts safe canonical URL", () => {
    setCanonical("https://example.com/page");
    const link = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement;
    expect(link.href).toContain("example.com/page");
  });
});
