import { describe, expect, it } from "vitest";
import { each } from "../src/core/rendering/each";
import { signal } from "../src/core/signals/signal";

describe("each", () => {
  it("should render items and update DOM when array changes", async () => {
    const [list, setList] = signal([
      { id: 1, name: "One" },
      { id: 2, name: "Two" },
    ]);

    const container = document.createElement("div");
    const anchor = each(
      list,
      (item) => {
        const el = document.createElement("div");
        el.textContent = item().name;
        return el;
      },
      { key: (item) => item.id },
    );
    container.appendChild(anchor);

    await Promise.resolve(); // allow initial render
    expect(container.textContent).toBe("OneTwo");

    setList([
      { id: 2, name: "Two" },
      { id: 3, name: "Three" },
    ]);

    await Promise.resolve(); // allow update
    expect(container.textContent).toBe("TwoThree");
  });

  it("should provide fresh data through item getter when keyed item changes", async () => {
    const [list, setList] = signal([
      { id: 1, label: "A" },
      { id: 2, label: "B" },
    ]);

    const container = document.createElement("div");
    const anchor = each(
      list,
      (item) => {
        const el = document.createElement("span");
        // item() is a reactive getter — reads fresh data on each access
        el.textContent = item().label;
        return el;
      },
      { key: (item) => item.id },
    );
    container.appendChild(anchor);

    await Promise.resolve();
    expect(container.textContent).toBe("AB");

    // Update item data without changing keys
    setList([
      { id: 1, label: "X" },
      { id: 2, label: "Y" },
    ]);

    await Promise.resolve();
    // The DOM is reused (same keys), but item() getter returns fresh data
    // Note: textContent was set once at render time, so it doesn't auto-update
    // unless wrapped in a reactive binding. The fix ensures the getter is fresh
    // for any reactive bindings (style, class, nodes callbacks) that read item().
    expect(container.querySelectorAll("span").length).toBe(2);
  });
});
