import { describe, expect, it } from "vitest";
import { VirtualList } from "../src/ui/virtualList";

describe("VirtualList", () => {
  it("should create a scrollable container", () => {
    const items = Array.from({ length: 100 }, (_, i) => `Item ${i}`);

    const el = VirtualList({
      items: () => items,
      itemHeight: 30,
      containerHeight: 300,
      renderItem: (item) => {
        const div = document.createElement("div");
        div.textContent = item;
        return div;
      },
    });

    expect(el.style.overflow).toBe("auto");
    expect(el.style.height).toBe("300px");
  });

  it("should apply custom class", () => {
    const el = VirtualList({
      items: () => ["a", "b"],
      itemHeight: 30,
      containerHeight: 300,
      class: "my-list",
      renderItem: (item) => {
        const div = document.createElement("div");
        div.textContent = item;
        return div;
      },
    });

    expect(el.className).toBe("my-list");
  });
});
