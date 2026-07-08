import { describe, expect, it } from "vitest";
import { signal } from "../src/core/signals/signal";
import { bindAttribute } from "../src/reactivity/bindAttribute";

describe("bindAttribute (with sanitization)", () => {
  it("should sanitize href and title attributes", () => {
    const [href, setHref] = signal("javascript:alert('xss')");
    const [title, setTitle] = signal("<img src=x>");

    const a = document.createElement("a");

    bindAttribute(a, "href", href);
    bindAttribute(a, "title", title);

    // sanitizeUrl blocks javascript: protocol — returns empty string
    expect(a.getAttribute("href")).toBe("");
    // setAttribute is XSS-safe — stores value as-is
    expect(a.getAttribute("title")).toBe("<img src=x>");

    setHref("https://safe.com/?q=<test>");
    setTitle('safe "quote"');

    expect(a.getAttribute("href")).toBe("https://safe.com/?q=<test>");
    expect(a.getAttribute("title")).toBe('safe "quote"');
  });

  it("should not sanitize unknown or safe attributes", () => {
    const [data, _setData] = signal("raw-data");
    const div = document.createElement("div");

    bindAttribute(div, "id", data);

    expect(div.id).toBe("raw-data"); // should not break anything
  });
});
