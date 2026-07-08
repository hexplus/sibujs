import { describe, expect, it } from "vitest";
import { html } from "../src/core/rendering/htm";
import { tagFactory } from "../src/core/rendering/tagFactory";
import { signal } from "../src/core/signals/signal";
import { sanitize, sanitizeAttribute, sanitizeUrl } from "../src/utils/sanitize";

// ── sanitize() — HTML entity escaping ────────────────────────────────────────

describe("sanitize (HTML entity escaping)", () => {
  it("escapes < and >", () => {
    expect(sanitize("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes quotes", () => {
    expect(sanitize('" onmouseover="alert(1)')).toBe("&quot; onmouseover=&quot;alert(1)");
  });

  it("escapes ampersands", () => {
    expect(sanitize("a&b")).toBe("a&amp;b");
  });

  it("escapes single quotes", () => {
    expect(sanitize("it's")).toBe("it&#39;s");
  });

  it("handles non-string input", () => {
    expect(sanitize(42)).toBe("42");
    expect(sanitize(null)).toBe("null");
    expect(sanitize(undefined)).toBe("undefined");
  });
});

// ── sanitizeUrl() — protocol injection prevention ────────────────────────────

describe("sanitizeUrl (protocol injection)", () => {
  it("blocks javascript: protocol", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBe("");
  });

  it("blocks JavaScript: (case insensitive)", () => {
    expect(sanitizeUrl("JavaScript:alert(1)")).toBe("");
  });

  it("blocks javascript: with leading whitespace/control chars", () => {
    expect(sanitizeUrl("\x00javascript:alert(1)")).toBe("");
    expect(sanitizeUrl("\x01javascript:alert(1)")).toBe("");
    expect(sanitizeUrl(" javascript:alert(1)")).toBe("");
    expect(sanitizeUrl("\tjavascript:alert(1)")).toBe("");
    expect(sanitizeUrl("\njavascript:alert(1)")).toBe("");
  });

  it("blocks javascript: with embedded control chars", () => {
    expect(sanitizeUrl("java\tscript:alert(1)")).toBe("");
    expect(sanitizeUrl("java\x00script:alert(1)")).toBe("");
  });

  it("blocks data: protocol", () => {
    expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBe("");
  });

  it("blocks vbscript: protocol", () => {
    expect(sanitizeUrl("vbscript:msgbox(1)")).toBe("");
  });

  it("blocks blob: protocol", () => {
    expect(sanitizeUrl("blob:http://evil.com/payload")).toBe("");
  });

  it("allows http/https URLs", () => {
    expect(sanitizeUrl("https://example.com")).toBe("https://example.com");
    expect(sanitizeUrl("http://example.com")).toBe("http://example.com");
  });

  it("allows relative URLs", () => {
    expect(sanitizeUrl("/page")).toBe("/page");
    expect(sanitizeUrl("./image.png")).toBe("./image.png");
    expect(sanitizeUrl("page.html")).toBe("page.html");
  });

  it("allows mailto: and tel:", () => {
    expect(sanitizeUrl("mailto:user@example.com")).toBe("mailto:user@example.com");
    expect(sanitizeUrl("tel:+1234567890")).toBe("tel:+1234567890");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeUrl("")).toBe("");
    expect(sanitizeUrl("   ")).toBe("");
  });
});

// ── sanitizeAttribute() — attribute-aware sanitization ───────────────────────

describe("sanitizeAttribute", () => {
  it("applies URL sanitization to href", () => {
    expect(sanitizeAttribute("href", "javascript:alert(1)")).toBe("");
  });

  it("applies URL sanitization to src", () => {
    expect(sanitizeAttribute("src", "data:text/html,<script>alert(1)</script>")).toBe("");
  });

  it("applies URL sanitization to action", () => {
    expect(sanitizeAttribute("action", "javascript:alert(1)")).toBe("");
  });

  it("applies HTML escaping to non-URL attributes", () => {
    expect(sanitizeAttribute("title", '<img onerror="alert(1)">')).toBe("&lt;img onerror=&quot;alert(1)&quot;&gt;");
  });

  it("applies HTML escaping to data-* attributes", () => {
    expect(sanitizeAttribute("data-payload", '"><script>alert(1)</script>')).toContain("&lt;script&gt;");
  });
});

// ── tagFactory — DOM-level XSS prevention ────────────────────────────────────

describe("tagFactory XSS prevention", () => {
  const div = tagFactory("div");
  const a = tagFactory("a");
  const img = tagFactory("img");
  const input = tagFactory("input");

  it("blocks onclick attribute", () => {
    const el = div({ onclick: "alert(1)" } as any);
    expect(el.hasAttribute("onclick")).toBe(false);
  });

  it("blocks onload attribute", () => {
    const el = img({ onload: "alert(1)", src: "/img.png" } as any);
    expect(el.hasAttribute("onload")).toBe(false);
  });

  it("blocks onerror attribute", () => {
    const el = img({ onerror: "alert(1)", src: "/img.png" } as any);
    expect(el.hasAttribute("onerror")).toBe(false);
  });

  it("blocks onfocus attribute", () => {
    const el = input({ onfocus: "alert(1)", type: "text" } as any);
    expect(el.hasAttribute("onfocus")).toBe(false);
  });

  it("sanitizes href with javascript: protocol", () => {
    const el = a({ href: "javascript:alert(1)", nodes: "click" });
    expect(el.getAttribute("href")).toBe("");
  });

  it("stores attribute values safely via setAttribute", () => {
    const el = div({ title: '"><script>alert(1)</script>' });
    const attr = el.getAttribute("title") || "";
    // setAttribute is XSS-safe — scripts in attribute values don't execute
    // The DOM stores the raw value; no entity escaping is needed
    expect(attr).toBe('"><script>alert(1)</script>');
  });

  it("children are always text nodes (never parsed as HTML)", () => {
    const el = div({ nodes: '<img src=x onerror="alert(1)">' });
    // The child should be a text node, not an img element
    expect(el.childNodes.length).toBe(1);
    expect(el.childNodes[0].nodeType).toBe(3); // TEXT_NODE
    expect(el.textContent).toContain("<img");
  });

  it("reactive children are text nodes too", () => {
    const [get] = signal("<script>alert(1)</script>");
    const el = div({ nodes: [() => get()] });
    // After reactive binding, content should be text, not parsed HTML
    expect(el.textContent).toContain("<script>");
    expect(el.querySelector("script")).toBeNull();
  });
});

// ── html`` tagged template — XSS prevention ─────────────────────────────────

describe("html tagged template XSS prevention", () => {
  it("expression children are text nodes, not parsed HTML", () => {
    const malicious = '<img src=x onerror="alert(1)">';
    const el = html`<div>${malicious}</div>`;
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<img");
  });

  it("expression attributes are sanitized", () => {
    const malicious = '"><script>alert(1)</script><div x="';
    const el = html`<div title=${malicious}></div>`;
    expect(el.querySelector("script")).toBeNull();
  });

  it("href expression with javascript: is blocked", () => {
    const el = html`<a href=${"javascript:alert(1)"}>click</a>`;
    const href = el.getAttribute("href") || "";
    expect(href).toBe("");
  });

  it("unquoted attribute mixing literal + expression keeps the interpolation (no marker leak)", () => {
    const el = html`<div data-x=foo${"bar"}></div>` as HTMLElement;
    // Previously the unquoted reader dropped the expression and leaked raw
    // \x00 marker bytes; the value must now be the concatenation "foobar".
    expect(el.getAttribute("data-x")).toBe("foobar");
    expect(el.getAttribute("data-x")).not.toContain("\x00");
  });

  it("unquoted href mixing literal + javascript: expression is still sanitized", () => {
    const el = html`<a href=java${"script:alert(1)"}>click</a>` as HTMLElement;
    const href = el.getAttribute("href") || "";
    expect(href).toBe("");
  });

  it("event handlers via on: are safe (function references, not strings)", () => {
    let called = false;
    const el = html`<button on:click=${() => {
      called = true;
    }}>click</button>`;
    // The event should be a function, not a string — no eval risk
    expect(el.hasAttribute("onclick")).toBe(false);
    el.click();
    expect(called).toBe(true);
  });

  it("on* attributes in expressions are blocked", () => {
    const el = html`<div onclick=${"alert(1)"}></div>`;
    expect(el.hasAttribute("onclick")).toBe(false);
  });
});
