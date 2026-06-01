import { afterEach, describe, expect, it, vi } from "vitest";
import { select } from "../src/widgets/Select";

function setup<T>(sel: ReturnType<typeof select<T>>, _items: T[]) {
  const listbox = document.createElement("div");
  const optionEls = new Map<number, HTMLElement>();
  const option = (_item: T, index: number) => {
    let el = optionEls.get(index);
    if (!el) {
      el = document.createElement("div");
      optionEls.set(index, el);
    }
    return el;
  };
  document.body.appendChild(listbox);
  const dispose = sel.bind({ listbox, option });
  return { listbox, option, optionEls, dispose };
}

const ITEMS = ["Apple", "Banana", "Cherry", "Date"];

describe("select coverage", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("single select replaces and closes", () => {
    const sel = select<string>({ items: ITEMS });
    sel.open();
    sel.select("Apple");
    expect(sel.selectedItems()).toEqual(["Apple"]);
    expect(sel.isOpen()).toBe(false);
    sel.select("Banana");
    expect(sel.selectedItems()).toEqual(["Banana"]);
  });

  it("multiple select accumulates and ignores duplicates", () => {
    const sel = select<string>({ items: ITEMS, multiple: true });
    sel.select("Apple");
    sel.select("Banana");
    sel.select("Apple");
    expect(sel.selectedItems()).toEqual(["Apple", "Banana"]);
    expect(sel.isOpen()).toBe(false);
  });

  it("selectedItem returns last selected or null", () => {
    const sel = select<string>({ items: ITEMS, multiple: true });
    expect(sel.selectedItem()).toBeNull();
    sel.select("Apple");
    sel.select("Cherry");
    expect(sel.selectedItem()).toBe("Cherry");
  });

  it("deselect, toggle, isSelected, clear", () => {
    const sel = select<string>({ items: ITEMS, multiple: true });
    sel.toggle("Apple");
    expect(sel.isSelected("Apple")).toBe(true);
    sel.toggle("Apple");
    expect(sel.isSelected("Apple")).toBe(false);
    sel.select("Banana");
    sel.deselect("Banana");
    expect(sel.isSelected("Banana")).toBe(false);
    sel.select("Cherry");
    sel.clear();
    expect(sel.selectedItems()).toEqual([]);
  });

  it("disabled items are rejected by select and skipped by highlight", () => {
    const sel = select<string>({
      items: ITEMS,
      isDisabled: (i) => i === "Banana",
    });
    sel.select("Banana");
    expect(sel.selectedItems()).toEqual([]);
    sel.highlightNext(); // 0 Apple
    expect(sel.highlightedIndex()).toBe(0);
    sel.highlightNext(); // skip Banana -> Cherry (2)
    expect(sel.highlightedIndex()).toBe(2);
  });

  it("highlightNext/Prev wrap around", () => {
    const sel = select<string>({ items: ITEMS });
    sel.highlightPrev(); // from -1 -> last
    expect(sel.highlightedIndex()).toBe(3);
    sel.highlightNext(); // wrap to 0
    expect(sel.highlightedIndex()).toBe(0);
    sel.highlightPrev(); // wrap to last
    expect(sel.highlightedIndex()).toBe(3);
  });

  it("highlight no-op on empty list", () => {
    const sel = select<string>({ items: [] });
    sel.highlightNext();
    sel.highlightPrev();
    expect(sel.highlightedIndex()).toBe(-1);
  });

  it("highlight returns prev when all items disabled", () => {
    const sel = select<string>({ items: ["a", "b"], isDisabled: () => true });
    sel.highlightNext();
    expect(sel.highlightedIndex()).toBe(-1);
  });

  it("selectHighlighted only selects valid index", () => {
    const sel = select<string>({ items: ITEMS });
    sel.selectHighlighted();
    expect(sel.selectedItems()).toEqual([]);
    sel.highlightNext();
    sel.selectHighlighted();
    expect(sel.selectedItems()).toEqual(["Apple"]);
  });

  it("open/close toggle", () => {
    const sel = select<string>({ items: ITEMS });
    sel.open();
    expect(sel.isOpen()).toBe(true);
    sel.close();
    expect(sel.isOpen()).toBe(false);
  });

  it("bind sets listbox role, multiselectable, tabindex and option aria", () => {
    const sel = select<string>({
      items: ITEMS,
      multiple: true,
      isDisabled: (i) => i === "Date",
    });
    const { listbox, optionEls } = setup(sel, ITEMS);
    expect(listbox.getAttribute("role")).toBe("listbox");
    expect(listbox.getAttribute("aria-multiselectable")).toBe("true");
    expect(listbox.tabIndex).toBe(0);
    for (const el of optionEls.values()) {
      expect(el.getAttribute("role")).toBe("option");
      expect(el.id).toBeTruthy();
    }
    expect(optionEls.get(3)!.getAttribute("aria-disabled")).toBe("true");
    sel.select("Apple");
    expect(optionEls.get(0)!.getAttribute("aria-selected")).toBe("true");
  });

  it("aria-activedescendant reflects highlight", () => {
    const sel = select<string>({ items: ITEMS });
    const { listbox, optionEls } = setup(sel, ITEMS);
    sel.highlightNext();
    expect(listbox.getAttribute("aria-activedescendant")).toBe(optionEls.get(0)!.id);
  });

  it("ArrowDown/ArrowUp navigate via keyboard", () => {
    const sel = select<string>({ items: ITEMS });
    const { listbox } = setup(sel, ITEMS);
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(sel.highlightedIndex()).toBe(0);
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(sel.highlightedIndex()).toBe(3);
  });

  it("Home and End keys", () => {
    const sel = select<string>({ items: ITEMS });
    const { listbox } = setup(sel, ITEMS);
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(sel.highlightedIndex()).toBe(3);
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(sel.highlightedIndex()).toBe(0);
  });

  it("Home/End no-op when empty", () => {
    const sel = select<string>({ items: [] });
    const { listbox } = setup(sel, []);
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(sel.highlightedIndex()).toBe(-1);
  });

  it("Enter and Space select highlighted only when index >= 0", () => {
    const sel = select<string>({ items: ITEMS });
    const { listbox } = setup(sel, ITEMS);
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(sel.selectedItems()).toEqual([]);
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(sel.selectedItems()).toEqual(["Apple"]);
  });

  it("typeahead highlights matching item and accumulates buffer", () => {
    vi.useFakeTimers();
    const sel = select<string>({ items: ITEMS });
    const { listbox } = setup(sel, ITEMS);
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
    expect(sel.highlightedIndex()).toBe(2); // Cherry
    // buffer resets after timeout window
    vi.advanceTimersByTime(500);
    // accumulate within window: "da" -> Date (no item starts with "d" then "da")
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "d" }));
    expect(sel.highlightedIndex()).toBe(3); // Date matches "d"
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(sel.highlightedIndex()).toBe(3); // "da" still Date
    vi.advanceTimersByTime(500);
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    expect(sel.highlightedIndex()).toBe(1); // Banana
  });

  it("typeahead uses bind-level itemToString override", () => {
    const sel = select<{ name: string }>({
      items: [{ name: "Xavier" }, { name: "Yara" }],
    });
    const listbox = document.createElement("div");
    const option = () => document.createElement("div");
    document.body.appendChild(listbox);
    sel.bind({ listbox, option, itemToString: (i) => i.name });
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "y" }));
    expect(sel.highlightedIndex()).toBe(1);
  });

  it("typeahead skips disabled items", () => {
    const sel = select<string>({
      items: ["Cat", "Car"],
      isDisabled: (i) => i === "Cat",
    });
    const { listbox } = setup(sel, ["Cat", "Car"]);
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
    expect(sel.highlightedIndex()).toBe(1); // Car (Cat disabled)
  });

  it("bind twice returns same teardown; teardown removes listener", () => {
    vi.useFakeTimers();
    const sel = select<string>({ items: ITEMS });
    const { listbox, option, dispose } = setup(sel, ITEMS);
    const again = sel.bind({ listbox, option });
    expect(again).toBe(dispose);
    // pending typeahead timer cleared on teardown
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    dispose();
    listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    // listener removed; index stays at typeahead result for "a" (Apple = 0)
    expect(sel.highlightedIndex()).toBe(0);
  });
});
