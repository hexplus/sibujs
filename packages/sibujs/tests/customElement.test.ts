import { describe, expect, it } from "vitest";
import { svgElement } from "../src/platform/customElement";

describe("svgElement", () => {
  it("should create SVG elements with namespace", () => {
    const circle = svgElement("circle", { cx: "50", cy: "50", r: "40" });
    expect(circle.tagName.toLowerCase()).toBe("circle");
    expect(circle.getAttribute("cx")).toBe("50");
    expect(circle.getAttribute("r")).toBe("40");
    expect(circle.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });

  it("should handle nodes", () => {
    const g = svgElement("g", {}, svgElement("rect", { width: "100", height: "100" }));
    expect(g.children.length).toBe(1);
    expect(g.children[0].tagName.toLowerCase()).toBe("rect");
  });

  it("should handle text nodes", () => {
    const textEl = svgElement("text", { x: "10", y: "20" }, "Hello SVG");
    expect(textEl.textContent).toBe("Hello SVG");
  });
});
