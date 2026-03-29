import { describe, expect, it } from "vitest";
import { show } from "../src/core/rendering/directives";
import { signal } from "../src/core/signals/signal";

describe("show — widened to Element", () => {
  it("should accept an Element (not just HTMLElement)", () => {
    const [visible] = signal(true);
    // tagFactory returns Element, not HTMLElement
    const el = document.createElement("div") as Element;

    const result = show(() => visible(), el);

    // Should return the same element
    expect(result).toBe(el);
    // Should be typed as Element (same type as input)
    expect(result instanceof Element).toBe(true);
  });

  it("should toggle display on HTMLElement", () => {
    const [visible, setVisible] = signal(true);
    const el = document.createElement("span");

    show(() => visible(), el);
    expect(el.style.display).toBe("");

    setVisible(false);
    expect(el.style.display).toBe("none");

    setVisible(true);
    expect(el.style.display).toBe("");
  });

  it("should work with SVG elements", () => {
    const [visible, setVisible] = signal(true);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "rect");

    show(() => visible(), svg);

    setVisible(false);
    expect((svg as unknown as HTMLElement).style.display).toBe("none");

    setVisible(true);
    expect((svg as unknown as HTMLElement).style.display).toBe("");
  });

  it("should preserve generic type (return same type as input)", () => {
    const [v] = signal(true);
    const div = document.createElement("div");
    // TypeScript should infer the return type as HTMLDivElement
    const result: HTMLDivElement = show(() => v(), div);
    expect(result.tagName).toBe("DIV");
  });
});
