import { describe, expect, it } from "vitest";
import { renderToDocument, trustHTML } from "../src/platform/ssr";

describe("TrustedHTML", () => {
  it("trustHTML should return a string value", () => {
    const html = trustHTML("<meta name='test' content='value'>");
    expect(html).toBe("<meta name='test' content='value'>");
  });

  it("trustHTML result should be usable as string", () => {
    const html = trustHTML("<link rel='stylesheet'>");
    // TrustedHTML is a branded string — it works as a string
    expect(html.length).toBeGreaterThan(0);
    expect(html.includes("link")).toBe(true);
  });
});

describe("renderToDocument", () => {
  it("should render a basic document", () => {
    const html = renderToDocument(() => {
      const el = document.createElement("div");
      el.textContent = "Hello";
      return el;
    });

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<div");
    expect(html).toContain("Hello");
    expect(html).toContain("</div>");
  });

  it("should include title when provided", () => {
    const html = renderToDocument(() => document.createElement("div"), { title: "My App" });

    expect(html).toContain("<title>My App</title>");
  });

  it("should escape title for XSS prevention", () => {
    const html = renderToDocument(() => document.createElement("div"), { title: "<script>alert('xss')</script>" });

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("should include meta tags", () => {
    const html = renderToDocument(() => document.createElement("div"), {
      meta: [{ name: "description", content: "A test page" }],
    });

    expect(html).toContain('name="description"');
    expect(html).toContain('content="A test page"');
  });

  it("should include link tags", () => {
    const html = renderToDocument(() => document.createElement("div"), {
      links: [{ rel: "stylesheet", href: "/style.css" }],
    });

    expect(html).toContain('rel="stylesheet"');
    expect(html).toContain('href="/style.css"');
  });

  it("should include script tags", () => {
    const html = renderToDocument(() => document.createElement("div"), { scripts: ["/app.js"] });

    expect(html).toContain('<script src="/app.js"></script>');
  });

  it("should include headExtra when provided as TrustedHTML", () => {
    const extra = trustHTML('<link rel="preconnect" href="https://fonts.googleapis.com">');
    const html = renderToDocument(() => document.createElement("div"), { headExtra: extra });

    expect(html).toContain('rel="preconnect"');
  });

  it("should include body attributes", () => {
    const html = renderToDocument(() => document.createElement("div"), {
      bodyAttrs: { class: "dark-mode", "data-theme": "dark" },
    });

    expect(html).toContain('class="dark-mode"');
    expect(html).toContain('data-theme="dark"');
  });

  it("should escape body attribute values", () => {
    const html = renderToDocument(() => document.createElement("div"), { bodyAttrs: { class: '"onload="alert(1)' } });

    // The quote in the value should be escaped so it can't break out of the attribute
    expect(html).toContain("&quot;");
    // The injected quote should NOT create a real attribute boundary break
    // i.e. there should be no unquoted onload= as a separate attribute
    expect(html).not.toMatch(/\s+onload=/);
  });
});
