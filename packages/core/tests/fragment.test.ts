import { describe, expect, it } from "vitest";
import { Fragment } from "../src/core/rendering/fragment";

describe("Fragment", () => {
  it("should group nodes without a wrapper element", () => {
    const p1 = document.createElement("p");
    p1.textContent = "First";
    const p2 = document.createElement("p");
    p2.textContent = "Second";

    const frag = Fragment([p1, p2]);

    expect(frag).toBeInstanceOf(DocumentFragment);
    expect(frag.childNodes.length).toBe(2);
  });

  it("should handle string nodes as text nodes", () => {
    const frag = Fragment(["Hello", "World"]);
    expect(frag.childNodes.length).toBe(2);
    expect(frag.childNodes[0].textContent).toBe("Hello");
    expect(frag.childNodes[1].textContent).toBe("World");
  });

  it("should handle null nodes gracefully", () => {
    const el = document.createElement("span");
    const frag = Fragment([null, el, null]);
    // null nodes are skipped
    expect(frag.childNodes.length).toBe(1);
    expect(frag.firstChild).toBe(el);
  });

  it("should append into a parent element", () => {
    const container = document.createElement("div");
    const frag = Fragment([document.createElement("span"), document.createElement("b")]);

    container.appendChild(frag);
    expect(container.children.length).toBe(2);
    expect(container.children[0].tagName).toBe("SPAN");
    expect(container.children[1].tagName).toBe("B");
  });
});
