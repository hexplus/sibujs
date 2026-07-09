import { store, tagFactory } from "@sibujs/core";
import {
  bindAttribute,
  isEventHandlerAttr,
  sanitizeAttributeString,
  sanitizeCSSValue,
  sanitizeUrl,
} from "@sibujs/core/internal";
import { createUniversalAdapter } from "sibujs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preloadModule } from "../src/performance/chunkLoader";
import { prefetch, preloadResource } from "../src/performance/domRecycler";

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// OWASP A03: Injection / XSS — URL protocol allowlist.
describe("sanitizeUrl rejects dangerous schemes (A03)", () => {
  const dangerous = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "  javascript:alert(1)",
    "javascript:alert(1)",
    "vbscript:msgbox(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "blob:https://x/abc",
    "file:///etc/passwd",
  ];
  for (const u of dangerous) {
    it(`blocks ${JSON.stringify(u).slice(0, 40)}`, () => {
      expect(sanitizeUrl(u)).toBe("");
    });
  }

  it("preserves safe + relative URLs", () => {
    for (const u of ["https://ok.example/p?q=1", "http://ok/x", "/rel/path", "mailto:a@b.com", "tel:+1", "#frag"]) {
      expect(sanitizeUrl(u)).not.toBe("");
    }
  });
});

// OWASP A03: CSS injection / data exfiltration.
describe("sanitizeCSSValue strips dangerous constructs (A03)", () => {
  it("blocks url(), expression(), and escape-encoded variants", () => {
    expect(sanitizeCSSValue("url(https://evil/x)")).toBe("");
    expect(sanitizeCSSValue("expression(alert(1))")).toBe("");
    expect(sanitizeCSSValue("ex\\70 ression(alert(1))")).toBe(""); // hex-escaped 'p'
    expect(sanitizeCSSValue("\\75 rl(x)")).toBe(""); // hex-escaped 'u'
    expect(sanitizeCSSValue("behavior:url(x)")).toBe("");
    expect(sanitizeCSSValue("@import 'x'")).toBe("");
  });
  it("keeps benign values", () => {
    expect(sanitizeCSSValue("red")).toBe("red");
    expect(sanitizeCSSValue("1px solid black")).toBe("1px solid black");
  });
});

// OWASP A03: event-handler attribute injection.
describe("event-handler attributes are refused (A03)", () => {
  it("isEventHandlerAttr flags on* handlers case-insensitively", () => {
    expect(isEventHandlerAttr("onclick")).toBe(true);
    expect(isEventHandlerAttr("ONERROR")).toBe(true);
    expect(isEventHandlerAttr("onmouseover")).toBe(true);
    expect(isEventHandlerAttr("href")).toBe(false);
    expect(isEventHandlerAttr("on")).toBe(false);
  });

  it("bindAttribute refuses to bind an event-handler attribute", () => {
    const el = document.createElement("a");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    bindAttribute(el, "onerror", () => "alert(1)");
    expect(el.hasAttribute("onerror")).toBe(false);
    warn.mockRestore();
  });

  it("reactive href is protocol-sanitized at bind time", () => {
    const el = document.createElement("a");
    bindAttribute(el, "href", () => "javascript:alert(1)");
    expect(el.getAttribute("href")).toBe(""); // dangerous scheme collapses to empty
  });
});

// OWASP A03: script-execution tags are blocked.
describe("script-execution tags are blocked (A03)", () => {
  for (const tag of ["script", "iframe", "object", "embed", "frame", "frameset"]) {
    it(`tagFactory("${tag}") throws on creation`, () => {
      expect(() => tagFactory(tag)()).toThrow(/blocked for security/);
    });
  }
});

// OWASP A08: prototype pollution via untrusted patches.
describe("store rejects prototype-pollution keys (A08)", () => {
  it("setState with __proto__/constructor does not poison Object.prototype", () => {
    const [, actions] = store<{ a: number }>({ a: 1 });
    actions.setState({ ["__proto__"]: { polluted: true }, ["constructor"]: { polluted: true } } as never);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});

// OWASP A03/A04: srcset uses per-candidate validation (the consolidated policy).
describe("sanitizeAttributeString applies sink-specific policy (A03)", () => {
  it("splits srcset and drops dangerous candidates", () => {
    const out = sanitizeAttributeString("srcset", "https://ok/a.jpg 1x, javascript:alert(1) 2x");
    expect(out).toBe("https://ok/a.jpg 1x");
  });
  it("sanitizes single-URL attributes", () => {
    expect(sanitizeAttributeString("href", "javascript:alert(1)")).toBe("");
  });
});

// The selector-injection fix in preloadModule (CWE-74).
describe("preloadModule resists CSS-selector injection (A03/CWE-74)", () => {
  it("does not throw on a URL containing selector metacharacters", () => {
    expect(() => preloadModule('/chunk.js"]</style><img src=x onerror=alert(1)>')).not.toThrow();
    // A modulepreload link is created (deduped safely), with the literal href.
    const links = Array.from(document.head.querySelectorAll('link[rel="modulepreload"]'));
    expect(links.length).toBe(1);
  });

  it("dedupes the same URL without creating a second link", () => {
    preloadModule("/safe-chunk.js");
    preloadModule("/safe-chunk.js");
    const links = Array.from(document.head.querySelectorAll('link[rel="modulepreload"][href="/safe-chunk.js"]'));
    expect(links.length).toBe(1);
  });

  it("refuses a dangerous scheme on a module preload", () => {
    preloadModule("javascript:alert(1)");
    expect(document.head.querySelector('link[rel="modulepreload"]')).toBeNull();
  });
});

// Resource-hint hrefs are now sanitized (defense-in-depth, A03/A10).
describe("resource-hint hrefs refuse dangerous schemes", () => {
  it("preloadResource drops javascript:/data: URLs", () => {
    preloadResource("javascript:alert(1)", "script");
    preloadResource("data:text/html,<script>alert(1)</script>", "fetch");
    expect(document.head.querySelector('link[rel="preload"]')).toBeNull();
  });
  it("preloadResource keeps safe URLs", () => {
    preloadResource("https://cdn.example/app.js", "script");
    expect(document.head.querySelector('link[rel="preload"][href="https://cdn.example/app.js"]')).toBeTruthy();
  });
  it("prefetch drops a javascript: URL", () => {
    prefetch("javascript:alert(1)");
    expect(document.head.querySelector('link[rel="prefetch"]')).toBeNull();
  });
});

// Testing-helper selectors resist CSS-selector injection (CWE-74, dev-tooling).
describe("testing adapters tolerate selector metacharacters", () => {
  it("byTestId / byLabelText do not throw on special-character values", () => {
    const adapter = createUniversalAdapter();
    const container = document.createElement("div");
    container.innerHTML = "<label for='a\"b'>Name</label><input id='a\"b' data-testid='x\"]y' />";
    document.body.appendChild(container);
    expect(() => adapter.queries.byTestId(container, 'x"]y')).not.toThrow();
    expect(() => adapter.queries.byLabelText(container, "Name")).not.toThrow();
    expect(adapter.queries.byTestId(container, 'x"]y')).toBeTruthy();
    document.body.removeChild(container);
  });
});
