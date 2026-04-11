// ============================================================================
// OWASP-catalog security tests
// ============================================================================
//
// Covers fixes applied across the router, bindAttribute, socket/stream,
// machine, and scopedStyle modules. Each test maps to a concrete attack
// class from the OWASP Top 10 2021 (A01-A10) or closely related CWEs.

import { describe, expect, it, vi } from "vitest";
import { machine } from "../src/patterns/machine";
import { bindAttribute } from "../src/reactivity/bindAttribute";

// ─── A01 Broken Access Control: router protocol guard ──────────────────────

import { createRouter, navigate } from "../src/plugins/router";

function div(): HTMLElement {
  return document.createElement("div");
}

describe("router / navigate — dangerous protocol block (A01)", () => {
  it("refuses javascript: navigation targets", async () => {
    createRouter([
      { path: "/", component: div },
      { path: "/safe", component: div },
    ]);
    const result = await navigate("javascript:alert(1)");
    expect(result.success).toBe(false);
  });

  it("refuses data: navigation targets", async () => {
    createRouter([{ path: "/", component: div }]);
    const result = await navigate("data:text/html,<script>alert(1)</script>");
    expect(result.success).toBe(false);
  });

  it("refuses vbscript: navigation targets", async () => {
    createRouter([{ path: "/", component: div }]);
    const result = await navigate("vbscript:msgbox(1)");
    expect(result.success).toBe(false);
  });

  it("allows safe path navigation", async () => {
    createRouter([
      { path: "/", component: div },
      { path: "/safe", component: div },
    ]);
    const result = await navigate("/safe");
    expect(result.success).toBe(true);
  });

  it("refuses a javascript: target returned by a route redirect", async () => {
    createRouter([
      { path: "/", component: div },
      { path: "/go", redirect: "javascript:alert(1)", component: div },
    ]);
    const result = await navigate("/go");
    expect(result.success).toBe(false);
  });

  it("refuses a javascript: target returned by a beforeEnter guard", async () => {
    createRouter([
      { path: "/", component: div },
      {
        path: "/gated",
        component: div,
        beforeEnter: () => "javascript:alert(1)",
      },
    ]);
    const result = await navigate("/gated");
    expect(result.success).toBe(false);
  });
});

// ─── A03 Injection: bindAttribute event-handler block ──────────────────────

describe("bindAttribute — event-handler refusal (A03)", () => {
  it("does not set onclick attribute via bindAttribute", () => {
    const el = document.createElement("button");
    const teardown = bindAttribute(el, "onclick", () => "alert(1)");
    expect(el.hasAttribute("onclick")).toBe(false);
    teardown();
  });

  it("does not set onerror attribute via bindAttribute", () => {
    const el = document.createElement("img");
    const teardown = bindAttribute(el, "onerror", () => "alert(1)");
    expect(el.hasAttribute("onerror")).toBe(false);
    teardown();
  });

  it("does not set OnLoad (mixed case) via bindAttribute", () => {
    const el = document.createElement("body");
    const teardown = bindAttribute(el, "OnLoad", () => "alert(1)");
    expect(el.hasAttribute("onload")).toBe(false);
    expect(el.hasAttribute("OnLoad")).toBe(false);
    teardown();
  });

  it("still allows safe attributes", () => {
    const el = document.createElement("input");
    const teardown = bindAttribute(el, "value", () => "hello");
    expect(el.value).toBe("hello");
    teardown();
  });

  it("still sanitizes javascript: URLs on href binding", () => {
    const el = document.createElement("a");
    const teardown = bindAttribute(el, "href", () => "javascript:alert(1)");
    expect(el.getAttribute("href") ?? "").not.toContain("javascript");
    teardown();
  });
});

// ─── A03 Prototype pollution: machine context merge ────────────────────────

describe("machine / context merge — prototype pollution (A03)", () => {
  it("drops __proto__ from action patches", () => {
    const m = machine({
      initial: "idle",
      context: { count: 0 },
      states: {
        idle: {
          on: {
            hack: {
              target: "idle",
              action: () => ({ __proto__: { polluted: true }, count: 1 }) as unknown as { count: number },
            },
          },
        },
      },
    });
    m.send("hack");
    expect(m.context().count).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("drops constructor from action patches", () => {
    const m = machine({
      initial: "idle",
      context: { x: 0 },
      states: {
        idle: {
          on: {
            go: {
              target: "idle",
              action: () => ({ constructor: "gotcha", x: 5 }) as unknown as { x: number },
            },
          },
        },
      },
    });
    m.send("go");
    expect(m.context().x).toBe(5);
    expect(String(m.context().constructor)).not.toBe("gotcha");
  });
});

// ─── A03 CSS injection: scopedStyle escape decoding ────────────────────────

import { scopedStyle } from "../src/ui/scopedStyle";

describe("scopedStyle — CSS escape bypass (A03)", () => {
  function cleanupStyles() {
    for (const s of document.head.querySelectorAll("style[data-sibu-scope]")) s.remove();
  }

  it("strips url() even when obfuscated with CSS hex escapes", () => {
    cleanupStyles();
    // `\75 rl(` → `url(` after CSS decode
    scopedStyle(".x { background: \\75 rl(javascript:alert(1)); }");
    const styleEl = document.head.querySelector("style[data-sibu-scope]");
    const text = styleEl?.textContent ?? "";
    expect(text).not.toContain("javascript");
    cleanupStyles();
  });

  it("strips expression() even when obfuscated", () => {
    cleanupStyles();
    // `e\78 pression` → `expression`
    scopedStyle(".x { width: e\\78 pression(alert(1)); }");
    const styleEl = document.head.querySelector("style[data-sibu-scope]");
    const text = styleEl?.textContent ?? "";
    // The alert payload must be stripped; the sanitizer leaves a
    // `/* expression() removed */` marker which is safe.
    expect(text).not.toContain("alert(1)");
    expect(text).toContain("removed");
    cleanupStyles();
  });

  it("strips @import when obfuscated", () => {
    cleanupStyles();
    // `\40 import` → `@import` (well, `\40 ` → `@`)
    scopedStyle("\\40 import url(evil.css);");
    const styleEl = document.head.querySelector("style[data-sibu-scope]");
    const text = styleEl?.textContent ?? "";
    expect(text).not.toContain("evil.css");
    expect(text).toContain("removed");
    cleanupStyles();
  });
});

// ─── A10 SSRF: socket / stream URL validation ──────────────────────────────

import { socket } from "../src/ui/socket";
import { stream } from "../src/ui/stream";

describe("socket — URL protocol guard (A10)", () => {
  it("refuses javascript: URL", () => {
    // Mock WebSocket so the test does not actually try to open a socket
    const ctor = vi.fn();
    vi.stubGlobal("WebSocket", ctor);
    const s = socket("javascript:alert(1)", { autoReconnect: false });
    expect(ctor).not.toHaveBeenCalled();
    expect(s.status()).toBe("closed");
    s.dispose();
    vi.unstubAllGlobals();
  });

  it("refuses http: URL (must be ws:/wss:)", () => {
    const ctor = vi.fn();
    vi.stubGlobal("WebSocket", ctor);
    const s = socket("http://example.com/ws", { autoReconnect: false });
    expect(ctor).not.toHaveBeenCalled();
    s.dispose();
    vi.unstubAllGlobals();
  });

  it("accepts wss:// URL", () => {
    const fakeInstance = {
      close: vi.fn(),
      send: vi.fn(),
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const ctor = vi.fn(() => fakeInstance);
    vi.stubGlobal("WebSocket", ctor);
    const s = socket("wss://example.com/ws", { autoReconnect: false });
    expect(ctor).toHaveBeenCalled();
    s.dispose();
    vi.unstubAllGlobals();
  });
});

describe("stream — URL protocol guard (A10)", () => {
  it("refuses javascript: URL", () => {
    const ctor = vi.fn();
    vi.stubGlobal("EventSource", ctor);
    const s = stream("javascript:alert(1)");
    expect(ctor).not.toHaveBeenCalled();
    expect(s.status()).toBe("closed");
    s.dispose();
    vi.unstubAllGlobals();
  });

  it("refuses data: URL", () => {
    const ctor = vi.fn();
    vi.stubGlobal("EventSource", ctor);
    const s = stream("data:text/event-stream,id:1");
    expect(ctor).not.toHaveBeenCalled();
    s.dispose();
    vi.unstubAllGlobals();
  });
});
