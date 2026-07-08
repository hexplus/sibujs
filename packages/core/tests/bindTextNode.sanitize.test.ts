import { describe, expect, it } from "vitest";
import { signal } from "../src/core/signals/signal";
import { bindTextNode } from "../src/reactivity/bindTextNode";

describe("bindTextNode (with sanitization)", () => {
  it("should set text content without double-escaping (textContent is inherently XSS-safe)", () => {
    const [value, setValue] = signal("<script>alert('xss')</script>");
    const node = document.createTextNode("");

    bindTextNode(node, value);

    // textContent never parses HTML — it displays the raw string as-is.
    // No entity-escaping is needed; that would cause visible "&lt;" in the UI.
    expect(node.textContent).toBe("<script>alert('xss')</script>");

    setValue("<b>bold</b>");
    expect(node.textContent).toBe("<b>bold</b>");

    setValue("Hello & World");
    expect(node.textContent).toBe("Hello & World");
  });
});
