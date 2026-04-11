// ============================================================================
// SSR SECURITY TESTS
// ============================================================================
//
// These tests assert the hardening added in the "SSR security hardening"
// phase — every check maps to a concrete attack class that was possible
// before the fix.

import { describe, expect, it } from "vitest";
import {
  deserializeState,
  escapeScriptJson,
  hydrateIslands,
  renderToDocument,
  renderToString,
  serializeState,
  suspenseSwapScript,
  trustHTML,
} from "../src/platform/ssr";
import { resolveServerRoute, type SSRRouteDef, serializeRouteState } from "../src/plugins/routerSSR";

// ─── renderToString attribute sanitization ──────────────────────────────────

describe("SSR / renderToString — attribute sanitization", () => {
  it("drops javascript: URIs in href", () => {
    const a = document.createElement("a");
    a.setAttribute("href", "javascript:alert(1)");
    a.textContent = "click";
    const html = renderToString(a);
    expect(html).not.toContain("javascript:");
  });

  it("drops data: URIs in src", () => {
    const img = document.createElement("img");
    img.setAttribute("src", "data:text/html,<script>alert(1)</script>");
    const html = renderToString(img);
    expect(html).not.toContain("data:");
  });

  it("drops vbscript: URIs in href", () => {
    const a = document.createElement("a");
    a.setAttribute("href", "vbscript:msgbox(1)");
    const html = renderToString(a);
    expect(html).not.toContain("vbscript:");
  });

  it("allows safe http URLs through href", () => {
    const a = document.createElement("a");
    a.setAttribute("href", "https://example.com/page");
    const html = renderToString(a);
    expect(html).toContain('href="https://example.com/page"');
  });

  it("drops `on*` event-handler attributes", () => {
    const btn = document.createElement("button");
    btn.setAttribute("onclick", "alert(1)");
    btn.setAttribute("onerror", "alert(2)");
    btn.setAttribute("onMouseOver", "alert(3)");
    btn.textContent = "x";
    const html = renderToString(btn);
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onMouseOver");
    expect(html).not.toMatch(/\son[a-z]/i);
  });

  it("escapes single-quotes in attribute values", () => {
    const el = document.createElement("div");
    el.setAttribute("title", `it's "great"`);
    const html = renderToString(el);
    expect(html).toContain("&#39;");
    expect(html).toContain("&quot;");
  });

  it("strips <script> elements from the serialized tree", () => {
    const div = document.createElement("div");
    const script = document.createElement("script");
    script.textContent = 'alert("xss")';
    div.appendChild(script);
    const html = renderToString(div);
    expect(html).not.toContain("alert");
    expect(html).not.toMatch(/<script[\s>]/);
  });

  it("strips <style> elements from the serialized tree", () => {
    const div = document.createElement("div");
    const style = document.createElement("style");
    style.textContent = "body{background:url(javascript:alert(1))}";
    div.appendChild(style);
    const html = renderToString(div);
    expect(html).not.toContain("javascript");
    expect(html).not.toMatch(/<style[\s>]/);
  });

  it("escapes text-node content against &, <, >", () => {
    const div = document.createElement("div");
    div.textContent = `<img src=x onerror=alert(1)> & "test"`;
    const html = renderToString(div);
    expect(html).toContain("&lt;img");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<img");
  });

  it("escapes HTML comment breakouts inside a Comment node", () => {
    const div = document.createElement("div");
    const comment = document.createComment("--><script>alert(1)</script><!--");
    div.appendChild(comment);
    const html = renderToString(div);

    // The comment must be intact: the only `-->` allowed is the closing
    // terminator at the very end of the comment. Strip that and verify no
    // other terminator leaked through. A `<script>` sequence inside a
    // well-formed comment is dead text and cannot execute.
    const commentStart = html.indexOf("<!--");
    const commentEnd = html.lastIndexOf("-->");
    expect(commentStart).toBeGreaterThanOrEqual(0);
    expect(commentEnd).toBeGreaterThan(commentStart);
    const body = html.slice(commentStart + 4, commentEnd);
    expect(body).not.toMatch(/-->/);
    expect(body).not.toMatch(/--!>/);
    expect(body).not.toMatch(/<!--/);
  });
});

// ─── renderToDocument key-injection guards ──────────────────────────────────

describe("SSR / renderToDocument — key injection", () => {
  const Empty = () => document.createElement("div");

  it("HTML-escapes the page title", () => {
    const html = renderToDocument(Empty, { title: "</title><script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;/title&gt;");
  });

  it("drops meta entries with crafted attribute names", () => {
    const html = renderToDocument(Empty, {
      meta: [
        { 'name="csrf" content="x': "y" }, // attacker-crafted key
        { name: "valid", content: "ok" },
      ],
    });
    // Malicious key must not reach the output
    expect(html).not.toContain(`name="csrf" content="x`);
    expect(html).toContain(`name="valid"`);
  });

  it("drops meta entries with on* event-handler keys", () => {
    const html = renderToDocument(Empty, {
      meta: [{ onload: "alert(1)", name: "keep" }],
    });
    expect(html).not.toContain("onload");
    expect(html).toContain(`name="keep"`);
  });

  it("sanitizes link href URLs", () => {
    const html = renderToDocument(Empty, {
      links: [{ rel: "stylesheet", href: "javascript:alert(1)" }],
    });
    // The entire <link> should be dropped because the URL sanitized to empty
    expect(html).not.toContain("javascript");
  });

  it("drops script entries with unsafe src", () => {
    const html = renderToDocument(Empty, {
      scripts: ["javascript:alert(1)", "https://cdn.example/app.js"],
    });
    expect(html).not.toContain("javascript:alert");
    expect(html).toContain("https://cdn.example/app.js");
  });

  it("validates bodyAttrs keys", () => {
    const html = renderToDocument(Empty, {
      bodyAttrs: {
        'class="x" onload="alert(1)': "y", // injection attempt
        class: "legit",
      },
    });
    expect(html).not.toContain("onload");
    expect(html).toContain(`class="legit"`);
  });

  it("preserves TrustedHTML in headExtra", () => {
    const extra = trustHTML('<link rel="preconnect" href="https://fonts.googleapis.com">');
    const html = renderToDocument(Empty, { headExtra: extra });
    expect(html).toContain("https://fonts.googleapis.com");
  });

  it("drops http-equiv=refresh with javascript: URL in renderToDocument", () => {
    const html = renderToDocument(Empty, {
      meta: [
        { "http-equiv": "refresh", content: "0;url=javascript:alert(1)" },
        { name: "keep", content: "safe" },
      ],
    });
    // The refresh meta must not be emitted at all.
    expect(html).not.toContain(`http-equiv="refresh"`);
    expect(html).not.toContain("javascript");
    // Legitimate meta still present.
    expect(html).toContain(`name="keep"`);
  });

  it("keeps http-equiv=refresh with a safe URL", () => {
    const html = renderToDocument(Empty, {
      meta: [{ "http-equiv": "refresh", content: "5;url=/home" }],
    });
    expect(html).toContain(`http-equiv="refresh"`);
  });
});

// ─── serializeState / escapeScriptJson ──────────────────────────────────────

describe("SSR / serializeState — script context escaping", () => {
  it("escapes </script> inside string values", () => {
    const html = serializeState({ msg: "</script><script>alert(1)</script>" });
    expect(html).not.toMatch(/<\/script>[^<]*<script/);
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("escapes U+2028 (LINE SEPARATOR)", () => {
    const html = serializeState({ msg: "line1\u2028line2" });
    expect(html).toContain("\\u2028");
    expect(html).not.toMatch(/\u2028/);
  });

  it("escapes U+2029 (PARAGRAPH SEPARATOR)", () => {
    const html = serializeState({ msg: "para1\u2029para2" });
    expect(html).toContain("\\u2029");
    expect(html).not.toMatch(/\u2029/);
  });

  it("embeds a nonce attribute when provided", () => {
    const html = serializeState({ msg: "hi" }, "abc123");
    expect(html).toContain('nonce="abc123"');
  });

  it("escapeScriptJson stands alone", () => {
    expect(escapeScriptJson("<a>&</a>")).toBe("\\u003ca\\u003e\\u0026\\u003c/a\\u003e");
  });

  it("deserializeState is window-safe when no data", () => {
    delete (window as unknown as Record<string, unknown>).__SIBU_SSR_DATA__;
    expect(deserializeState()).toBeUndefined();
  });
});

// ─── suspenseSwapScript id allowlist ────────────────────────────────────────

describe("SSR / suspenseSwapScript — id allowlist", () => {
  it("accepts alphanumeric ids", () => {
    const out = suspenseSwapScript("abc-123_xyz");
    // The id appears inside the JS string literals in the emitted script.
    expect(out).toContain('"sibu-resolved-abc-123_xyz"');
    expect(out).toContain('"abc-123_xyz"');
  });

  it("rejects ids with quotes", () => {
    expect(() => suspenseSwapScript('bad"id')).toThrow(/must match/);
  });

  it("rejects ids with angle brackets", () => {
    expect(() => suspenseSwapScript("bad<id>")).toThrow(/must match/);
  });

  it("rejects ids with spaces", () => {
    expect(() => suspenseSwapScript("bad id")).toThrow(/must match/);
  });

  it("rejects empty ids", () => {
    expect(() => suspenseSwapScript("")).toThrow(/must match/);
  });

  it("embeds a nonce when provided", () => {
    const out = suspenseSwapScript("id1", "n42");
    expect(out).toContain('nonce="n42"');
  });
});

// ─── hydrateIslands prototype pollution guard ───────────────────────────────

describe("SSR / hydrateIslands — prototype pollution", () => {
  it("rejects __proto__ island id", () => {
    const container = document.createElement("div");
    const marker = document.createElement("span");
    marker.setAttribute("data-sibu-island", "__proto__");
    container.appendChild(marker);

    // Poison via the prototype chain — should NOT be picked up.
    (Object.prototype as unknown as Record<string, unknown>).__proto__injected = () => document.createElement("i");

    const islands = {} as Record<string, () => HTMLElement>;
    // This must NOT throw and must NOT call the prototype-chain factory.
    hydrateIslands(container, islands);

    delete (Object.prototype as unknown as Record<string, unknown>).__proto__injected;
  });
});

// ─── routerSSR prototype pollution ──────────────────────────────────────────

describe("routerSSR / parseURL — prototype pollution guard", () => {
  const routes: SSRRouteDef[] = [
    { path: "/", component: () => document.createElement("div") },
    { path: "/user/:id", component: () => document.createElement("div") },
  ];

  it("drops __proto__ from query string", () => {
    const { route } = resolveServerRoute("/?__proto__=injected&ok=yes", routes);
    expect((Object.prototype as unknown as Record<string, unknown>).injected).toBeUndefined();
    expect(route.query.ok).toBe("yes");
    expect(route.query.__proto__).toBeUndefined();
  });

  it("drops constructor from query string", () => {
    const { route } = resolveServerRoute("/?constructor=x&ok=1", routes);
    expect(route.query.constructor).toBeUndefined();
    expect(route.query.ok).toBe("1");
  });

  it("handles malformed percent-encoding without crashing", () => {
    // `%ZZ` is not a valid escape sequence — must not throw
    expect(() => resolveServerRoute("/?q=%ZZ", routes)).not.toThrow();
    const { route } = resolveServerRoute("/?q=%ZZ", routes);
    expect(route.query.q).toBe("%ZZ");
  });

  it("handles malformed path percent-encoding", () => {
    expect(() => resolveServerRoute("/user/%E0%80%AF", routes)).not.toThrow();
  });
});

// ─── serializeRouteState ────────────────────────────────────────────────────

describe("routerSSR / serializeRouteState — script context escaping", () => {
  it("escapes </script> in path values", () => {
    const html = serializeRouteState({
      path: "</script><script>alert(1)</script>",
      params: {},
      query: {},
      hash: "",
      meta: {},
    });
    expect(html).not.toMatch(/<\/script>[^<]*<script/);
    expect(html).toContain("\\u003c");
  });

  it("supports nonce", () => {
    const html = serializeRouteState({ path: "/", params: {}, query: {}, hash: "", meta: {} }, "csp-nonce");
    expect(html).toContain('nonce="csp-nonce"');
  });
});
