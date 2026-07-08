import { describe, expect, it } from "vitest";
import { select } from "../src/widgets/Select";

describe("select", () => {
  const fruits = ["Apple", "Banana", "Cherry"];

  it("starts with no selection and closed", () => {
    const sel = select({ items: fruits });
    expect(sel.selectedItems()).toEqual([]);
    expect(sel.selectedItem()).toBeNull();
    expect(sel.isOpen()).toBe(false);
    expect(sel.highlightedIndex()).toBe(-1);
  });

  it("selects an item in single mode and closes dropdown", () => {
    const sel = select({ items: fruits });
    sel.open();
    sel.select("Banana");
    expect(sel.selectedItem()).toBe("Banana");
    expect(sel.selectedItems()).toEqual(["Banana"]);
    expect(sel.isOpen()).toBe(false);
  });

  it("replaces selection in single mode", () => {
    const sel = select({ items: fruits });
    sel.select("Apple");
    sel.select("Cherry");
    expect(sel.selectedItems()).toEqual(["Cherry"]);
    expect(sel.selectedItem()).toBe("Cherry");
  });

  it("supports multi-select mode", () => {
    const sel = select({ items: fruits, multiple: true });
    sel.select("Apple");
    sel.select("Cherry");
    expect(sel.selectedItems()).toEqual(["Apple", "Cherry"]);
    expect(sel.isSelected("Apple")).toBe(true);
    expect(sel.isSelected("Banana")).toBe(false);
  });

  it("toggles and deselects items", () => {
    const sel = select({ items: fruits, multiple: true });
    sel.toggle("Apple");
    expect(sel.isSelected("Apple")).toBe(true);

    sel.toggle("Apple");
    expect(sel.isSelected("Apple")).toBe(false);

    sel.select("Banana");
    sel.deselect("Banana");
    expect(sel.selectedItems()).toEqual([]);
  });

  it("navigates highlights and selects highlighted", () => {
    const sel = select({ items: fruits });
    sel.highlightNext(); // 0
    expect(sel.highlightedIndex()).toBe(0);
    sel.highlightNext(); // 1
    sel.highlightNext(); // 2
    sel.highlightNext(); // wraps to 0
    expect(sel.highlightedIndex()).toBe(0);

    sel.highlightPrev(); // wraps to 2
    expect(sel.highlightedIndex()).toBe(2);

    sel.selectHighlighted();
    expect(sel.selectedItem()).toBe("Cherry");
  });

  it("clears all selections", () => {
    const sel = select({ items: fruits, multiple: true });
    sel.select("Apple");
    sel.select("Cherry");
    sel.clear();
    expect(sel.selectedItems()).toEqual([]);
    expect(sel.selectedItem()).toBeNull();
  });
});
