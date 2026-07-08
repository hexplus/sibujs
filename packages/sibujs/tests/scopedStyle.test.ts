import { beforeEach, describe, expect, it } from "vitest";
import { removeScopedStyle, scopedStyle, withScopedStyle } from "../src/ui/scopedStyle";

describe("scopedStyle", () => {
  beforeEach(() => {
    for (const el of document.head.querySelectorAll("style[data-sibu-scope]")) el.remove();
  });

  it("should create a scoped style with unique id", () => {
    const { scope, attr } = scopedStyle(".btn { color: red; }");
    expect(scope).toBeTruthy();
    expect(attr).toContain("data-sibu-s");

    const styleEl = document.head.querySelector(`style[data-sibu-scope="${scope}"]`);
    expect(styleEl).not.toBeNull();
  });

  it("should remove scoped style", () => {
    const { scope } = scopedStyle(".test { margin: 0; }");
    expect(document.head.querySelector(`style[data-sibu-scope="${scope}"]`)).not.toBeNull();

    removeScopedStyle(scope);
    expect(document.head.querySelector(`style[data-sibu-scope="${scope}"]`)).toBeNull();
  });
});

describe("scopedStyle — CSS sanitization", () => {
  beforeEach(() => {
    for (const el of document.head.querySelectorAll("style[data-sibu-scope]")) el.remove();
  });

  it("should strip url() from CSS", () => {
    const { scope } = scopedStyle(".bg { background: url(https://evil.com/steal); }");
    const styleEl = document.head.querySelector(`style[data-sibu-scope="${scope}"]`);
    // The dangerous URL value should be replaced; only the safe comment remains
    expect(styleEl?.textContent).not.toContain("evil.com");
    expect(styleEl?.textContent).toContain("/* url() removed */");
  });

  it("should strip url() with double quotes", () => {
    const { scope } = scopedStyle('.bg { background: url("https://evil.com/steal"); }');
    const styleEl = document.head.querySelector(`style[data-sibu-scope="${scope}"]`);
    expect(styleEl?.textContent).not.toContain("evil.com");
  });

  it("should strip url() with single quotes", () => {
    const { scope } = scopedStyle(".bg { background: url('https://evil.com/steal'); }");
    const styleEl = document.head.querySelector(`style[data-sibu-scope="${scope}"]`);
    expect(styleEl?.textContent).not.toContain("evil.com");
  });

  it("should strip @import rules", () => {
    const { scope } = scopedStyle('@import url("https://evil.com/style.css"); .x { color: red; }');
    const styleEl = document.head.querySelector(`style[data-sibu-scope="${scope}"]`);
    expect(styleEl?.textContent).not.toContain("evil.com");
    expect(styleEl?.textContent).toContain("/* @import removed */");
    expect(styleEl?.textContent).toContain("color: red");
  });

  it("should strip expression()", () => {
    const { scope } = scopedStyle(".x { width: expression(document.body.clientWidth); }");
    const styleEl = document.head.querySelector(`style[data-sibu-scope="${scope}"]`);
    expect(styleEl?.textContent).not.toContain("document.body");
    expect(styleEl?.textContent).toContain("/* expression() removed */");
  });

  it("should strip -moz-binding", () => {
    const { scope } = scopedStyle(".x { -moz-binding: url(evil.xml#xbl); }");
    const styleEl = document.head.querySelector(`style[data-sibu-scope="${scope}"]`);
    expect(styleEl?.textContent).not.toContain("evil.xml");
    expect(styleEl?.textContent).toContain("/* -moz-binding removed */");
  });

  it("should strip behavior", () => {
    const { scope } = scopedStyle(".x { behavior: url(evil.htc); }");
    const styleEl = document.head.querySelector(`style[data-sibu-scope="${scope}"]`);
    expect(styleEl?.textContent).not.toContain("evil.htc");
    expect(styleEl?.textContent).toContain("/* behavior removed */");
  });

  it("should preserve safe CSS", () => {
    const { scope } = scopedStyle(".safe { color: red; font-size: 16px; display: flex; }");
    const styleEl = document.head.querySelector(`style[data-sibu-scope="${scope}"]`);
    expect(styleEl?.textContent).toContain("color: red");
    expect(styleEl?.textContent).toContain("font-size: 16px");
    expect(styleEl?.textContent).toContain("display: flex");
  });
});

describe("withScopedStyle", () => {
  it("should wrap a component with scoped styles", () => {
    const MyComponent = withScopedStyle(".inner { color: blue; }", () => {
      const el = document.createElement("div");
      el.className = "inner";
      return el;
    });

    const el = MyComponent({} as unknown as Record<string, unknown>);
    expect(el.tagName.toLowerCase()).toBe("div");
    // Should have scope attribute
    const attrs = Array.from(el.attributes);
    expect(attrs.some((a) => a.name.startsWith("data-sibu-s"))).toBe(true);
  });
});
