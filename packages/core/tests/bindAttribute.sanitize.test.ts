import { describe, expect, it } from "vitest";
import { signal } from "../src/core/signals/signal";
import { bindAttribute, bindDynamic } from "../src/reactivity/bindAttribute";

describe("bindAttribute (with sanitization)", () => {
  it("should block javascript: protocol in href attributes", () => {
    const [href] = signal("javascript:alert('xss')");
    const a = document.createElement("a");

    bindAttribute(a, "href", href);
    // sanitizeUrl blocks javascript: — returns empty string
    expect(a.getAttribute("href")).toBe("");
  });

  it("should block javascript: in src attributes", () => {
    const [src] = signal("javascript:alert(1)");
    const img = document.createElement("img");

    bindAttribute(img, "src", src);
    expect(img.getAttribute("src")).toBe("");
  });

  it("should allow safe URLs in href", () => {
    const [href, setHref] = signal("https://safe.com/path");
    const a = document.createElement("a");

    bindAttribute(a, "href", href);
    expect(a.getAttribute("href")).toBe("https://safe.com/path");

    setHref("/relative/path");
    expect(a.getAttribute("href")).toBe("/relative/path");
  });

  it("should store title attributes safely via setAttribute", () => {
    const [title, setTitle] = signal("<img src=x>");
    const el = document.createElement("div");

    bindAttribute(el, "title", title);
    // setAttribute is XSS-safe — the value is stored as-is (no entity escaping needed)
    expect(el.getAttribute("title")).toBe("<img src=x>");

    setTitle('safe "quote"');
    expect(el.getAttribute("title")).toBe('safe "quote"');
  });

  it("should store non-URL attributes safely via setAttribute", () => {
    const [val] = signal('<script>alert("xss")</script>');
    const el = document.createElement("div");

    bindAttribute(el, "data-info", val);
    // setAttribute is XSS-safe — scripts in attribute values don't execute
    expect(el.getAttribute("data-info")).toBe('<script>alert("xss")</script>');
  });

  it("should not sanitize safe attributes like 'id'", () => {
    const [id, setId] = signal("raw-data");
    const el = document.createElement("div");

    bindAttribute(el, "id", id);
    expect(el.id).toBe("raw-data");

    setId("updated-id");
    expect(el.id).toBe("updated-id");
  });
});

describe("bindDynamic (security)", () => {
  it("should block event handler attribute names", () => {
    const el = document.createElement("div");

    bindDynamic(el, "onclick", "alert(1)");
    expect(el.hasAttribute("onclick")).toBe(false);

    bindDynamic(el, "ONLOAD", "alert(1)");
    expect(el.hasAttribute("onload")).toBe(false);
    expect(el.hasAttribute("ONLOAD")).toBe(false);
  });

  it("should allow safe dynamic attributes", () => {
    const el = document.createElement("div");

    bindDynamic(el, "data-value", "safe");
    expect(el.getAttribute("data-value")).toBe("safe");
  });

  it("should sanitize URL attributes in dynamic binding", () => {
    const el = document.createElement("a");

    bindDynamic(el, "href", "javascript:alert(1)");
    expect(el.getAttribute("href")).toBe("");
  });

  it("should sanitize URL attributes regardless of name case (HTML attrs are case-insensitive)", () => {
    const a = document.createElement("a");
    // "HREF"/"Href" must still be recognized as a URL attribute — otherwise the
    // javascript: URL would reach the live DOM (browser treats HREF as href).
    bindDynamic(a, "HREF", "javascript:alert(1)");
    expect(a.getAttribute("HREF")).toBe("");

    const img = document.createElement("img");
    bindDynamic(img, "SRC", "javascript:alert(1)");
    expect(img.getAttribute("SRC")).toBe("");
  });
});

describe("bindAttribute (URL attr case-insensitivity)", () => {
  it("sanitizes a reactively-bound uppercase HREF", () => {
    const [href] = signal("javascript:alert(1)");
    const a = document.createElement("a");
    bindAttribute(a, "HREF", href);
    expect(a.getAttribute("HREF")).toBe("");
  });
});
