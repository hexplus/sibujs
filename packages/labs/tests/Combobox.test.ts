import { describe, expect, it } from "vitest";
import { combobox } from "../src/widgets/Combobox";

describe("combobox", () => {
  const fruits = ["Apple", "Banana", "Cherry", "Date", "Elderberry"];

  it("starts with empty query, all items, and closed", () => {
    const cb = combobox({ items: fruits });
    expect(cb.query()).toBe("");
    expect(cb.filteredItems()).toEqual(fruits);
    expect(cb.isOpen()).toBe(false);
    expect(cb.selectedItem()).toBeNull();
    expect(cb.highlightedIndex()).toBe(-1);
  });

  it("filters items based on query", () => {
    const cb = combobox({ items: fruits });
    cb.setQuery("an");
    expect(cb.filteredItems()).toEqual(["Banana"]);
  });

  it("selects an item, updates query, and closes", () => {
    const cb = combobox({ items: fruits });
    cb.open();
    expect(cb.isOpen()).toBe(true);

    cb.select("Cherry");
    expect(cb.selectedItem()).toBe("Cherry");
    expect(cb.query()).toBe("Cherry");
    expect(cb.isOpen()).toBe(false);
  });

  it("navigates highlighted index with next/prev and wraps around", () => {
    const cb = combobox({ items: ["A", "B", "C"] });
    cb.highlightNext();
    expect(cb.highlightedIndex()).toBe(0);
    cb.highlightNext();
    expect(cb.highlightedIndex()).toBe(1);
    cb.highlightNext();
    expect(cb.highlightedIndex()).toBe(2);
    cb.highlightNext();
    expect(cb.highlightedIndex()).toBe(0); // wraps

    cb.highlightPrev();
    expect(cb.highlightedIndex()).toBe(2); // wraps backward
  });

  it("selects highlighted item", () => {
    const cb = combobox({ items: fruits });
    cb.highlightNext(); // index 0 -> Apple
    cb.selectHighlighted();
    expect(cb.selectedItem()).toBe("Apple");
    expect(cb.query()).toBe("Apple");
  });

  it("supports custom filterFn and itemToString", () => {
    const items = [
      { name: "Alice", age: 30 },
      { name: "Bob", age: 25 },
      { name: "Charlie", age: 35 },
    ];
    const cb = combobox({
      items,
      filterFn: (item, q) => item.name.toLowerCase().includes(q.toLowerCase()),
      itemToString: (item) => item.name,
    });

    cb.setQuery("ali");
    expect(cb.filteredItems()).toEqual([{ name: "Alice", age: 30 }]);

    cb.select(items[1]);
    expect(cb.query()).toBe("Bob");
  });
});
