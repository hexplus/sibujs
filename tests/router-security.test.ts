import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter, destroyRouter, navigate, RouterLink, route, setRoutes } from "../src/plugins/router";

// ============================================================================
// ROUTER SECURITY TESTS
// ============================================================================
// Cover the click-to-XSS and open-redirect fixes in the router.

describe("RouterLink — href sanitization (click-to-XSS)", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes([]);
  });

  afterEach(() => {
    try {
      destroyRouter();
    } catch {}
  });

  it("neutralizes a javascript: target", () => {
    const link = RouterLink({ to: "javascript:alert(document.cookie)" });
    // Must not render a live javascript: URL — collapses to "#".
    expect(link.getAttribute("href")).toBe("#");
    expect(link.href.startsWith("javascript:")).toBe(false);
  });

  it("neutralizes a data: target", () => {
    const link = RouterLink({ to: "data:text/html,<script>alert(1)</script>" });
    expect(link.getAttribute("href")).toBe("#");
  });

  it("neutralizes a protocol-relative target", () => {
    const link = RouterLink({ to: "//evil.com/phish" });
    expect(link.getAttribute("href")).toBe("#");
  });

  it("neutralizes a backslash-obfuscated protocol-relative target", () => {
    const link = RouterLink({ to: "/\\/evil.com" });
    expect(link.getAttribute("href")).toBe("#");
  });

  it("preserves a safe internal path", () => {
    const link = RouterLink({ to: "/about?tab=1#top" });
    expect(link.getAttribute("href")).toBe("/about?tab=1#top");
  });

  it("does not let a spread HREF/Href attribute override the sanitized href", () => {
    const link = RouterLink({ to: "/safe", HREF: "javascript:alert(1)", Href: "data:text/html,x" } as never);
    // The canonical href stays safe; the case-variant aliases are skipped, so
    // the (case-insensitive) href attribute still resolves to the safe value.
    expect(link.href.startsWith("javascript:")).toBe(false);
    expect(link.href.startsWith("data:")).toBe(false);
    expect(link.getAttribute("href")).toBe("/safe");
  });

  it("does not let a spread on*-handler attribute (any case) attach", () => {
    const link = RouterLink({ to: "/safe", ONCLICK: "alert(1)", OnMouseOver: "alert(2)" } as never);
    expect(link.hasAttribute("ONCLICK")).toBe(false);
    expect(link.hasAttribute("onclick")).toBe(false);
    expect(link.hasAttribute("OnMouseOver")).toBe(false);
  });

  it("sanitizes other URL-bearing spread attributes (e.g. src)", () => {
    const link = RouterLink({ to: "/safe", src: "javascript:alert(1)" } as never);
    // Dropped because sanitizeUrl returns empty for javascript:.
    expect(link.getAttribute("src")).toBeNull();
  });

  it("sanitizes a spread style attribute (CSS injection)", () => {
    const link = RouterLink({ to: "/safe", style: "background:url(javascript:alert(1))" } as never);
    const style = link.getAttribute("style") ?? "";
    // sanitizeCSSValue strips url()/expression()/behavior etc.
    expect(style).not.toContain("url(");
    expect(style).not.toContain("javascript:");
  });
});

describe("Router — open-redirect guard", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes([]);
    if (!vi.isMockFunction(console.error)) console.error = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      destroyRouter();
    } catch {}
  });

  const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

  it("refuses a redirect to a protocol-relative target", async () => {
    setRoutes([
      { path: "/start", redirect: "//evil.com" },
      { path: "/", component: () => document.createElement("div") },
    ]);
    await navigate("/start").catch(() => {});
    await wait();
    // Navigation must not have landed on the off-origin host.
    expect(route().path).not.toBe("//evil.com");
  });

  it("refuses a redirect to a backslash-obfuscated target (normalization bypass)", async () => {
    setRoutes([
      { path: "/start", redirect: "/\\/evil.com" },
      { path: "/", component: () => document.createElement("div") },
    ]);
    await navigate("/start").catch(() => {});
    await wait();
    expect(route().path.replace(/\\/g, "/").startsWith("//")).toBe(false);
  });

  it("allows a safe internal redirect", async () => {
    setRoutes([
      { path: "/start", redirect: "/home" },
      { path: "/home", component: () => document.createElement("div") },
    ]);
    await navigate("/start").catch(() => {});
    await wait();
    expect(route().path).toBe("/home");
  });
});
