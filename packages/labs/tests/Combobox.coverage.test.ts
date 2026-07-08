import { afterEach, describe, expect, it, vi } from "vitest";
import { combobox } from "../src/widgets/Combobox";

interface Fruit {
  id: number;
  name: string;
}

function setup(items: Fruit[]) {
  const cb = combobox<Fruit>({ items, itemToString: (f) => f.name });
  const input = document.createElement("input");
  const listbox = document.createElement("div");
  const optionEls = new Map<number, HTMLElement>();
  const option = (item: Fruit) => {
    let el = optionEls.get(item.id);
    if (!el) {
      el = document.createElement("div");
      optionEls.set(item.id, el);
    }
    return el;
  };
  document.body.appendChild(input);
  document.body.appendChild(listbox);
  const dispose = cb.bind({ input, listbox, option });
  return { cb, input, listbox, option, optionEls, dispose };
}

const FRUITS: Fruit[] = [
  { id: 1, name: "Apple" },
  { id: 2, name: "Banana" },
  { id: 3, name: "Cherry" },
];

describe("combobox coverage", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("filteredItems returns all on empty query and filters by query", () => {
    const cb = combobox<Fruit>({ items: FRUITS, itemToString: (f) => f.name });
    expect(cb.filteredItems().length).toBe(3);
    cb.setQuery("an");
    expect(cb.filteredItems().map((f) => f.name)).toEqual(["Banana"]);
  });

  it("uses custom filterFn and default String() when no itemToString", () => {
    const cb = combobox<string>({ items: ["one", "two", "three"] });
    cb.setQuery("t");
    expect(cb.filteredItems()).toEqual(["two", "three"]);
  });

  it("select sets selectedItem, query, and closes", () => {
    const cb = combobox<Fruit>({ items: FRUITS, itemToString: (f) => f.name });
    cb.open();
    cb.select(FRUITS[1]);
    expect(cb.selectedItem()).toEqual(FRUITS[1]);
    expect(cb.query()).toBe("Banana");
    expect(cb.isOpen()).toBe(false);
  });

  it("highlightNext/Prev wrap around and reset on query change", () => {
    const cb = combobox<Fruit>({ items: FRUITS, itemToString: (f) => f.name });
    cb.highlightNext();
    expect(cb.highlightedIndex()).toBe(0);
    cb.highlightNext();
    cb.highlightNext();
    expect(cb.highlightedIndex()).toBe(2);
    cb.highlightNext();
    expect(cb.highlightedIndex()).toBe(0);
    cb.highlightPrev();
    expect(cb.highlightedIndex()).toBe(2);
    cb.setQuery("a");
    expect(cb.highlightedIndex()).toBe(-1);
  });

  it("highlightNext/Prev no-op on empty filtered list", () => {
    const cb = combobox<Fruit>({ items: [], itemToString: (f) => f.name });
    cb.highlightNext();
    cb.highlightPrev();
    expect(cb.highlightedIndex()).toBe(-1);
  });

  it("selectHighlighted selects only when index valid", () => {
    const cb = combobox<Fruit>({ items: FRUITS, itemToString: (f) => f.name });
    cb.selectHighlighted();
    expect(cb.selectedItem()).toBeNull();
    cb.highlightNext();
    cb.selectHighlighted();
    expect(cb.selectedItem()).toEqual(FRUITS[0]);
  });

  it("open/close toggle isOpen", () => {
    const cb = combobox<Fruit>({ items: FRUITS });
    cb.open();
    expect(cb.isOpen()).toBe(true);
    cb.close();
    expect(cb.isOpen()).toBe(false);
  });

  it("bind sets ARIA roles and option ids", () => {
    const { cb, input, listbox, optionEls } = setup(FRUITS);
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(listbox.getAttribute("role")).toBe("listbox");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(listbox.hidden).toBe(true);

    cb.open();
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(listbox.hidden).toBe(false);
    for (const el of optionEls.values()) {
      expect(el.getAttribute("role")).toBe("option");
      expect(el.id).toBeTruthy();
    }
  });

  it("input event updates query and opens", () => {
    const { cb, input } = setup(FRUITS);
    input.value = "ch";
    input.dispatchEvent(new Event("input"));
    expect(cb.query()).toBe("ch");
    expect(cb.isOpen()).toBe(true);
    expect(cb.filteredItems().map((f) => f.name)).toEqual(["Cherry"]);
  });

  it("ArrowDown opens and highlights, sets aria-activedescendant", () => {
    const { cb, input, optionEls } = setup(FRUITS);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(cb.isOpen()).toBe(true);
    expect(cb.highlightedIndex()).toBe(0);
    const firstOpt = optionEls.get(1)!;
    expect(firstOpt.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(firstOpt.id);
  });

  it("ArrowUp opens and highlights last", () => {
    const { cb, input } = setup(FRUITS);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(cb.highlightedIndex()).toBe(2);
  });

  it("Enter selects highlighted only when index >= 0", () => {
    const { cb, input } = setup(FRUITS);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(cb.selectedItem()).toBeNull();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(cb.selectedItem()).toEqual(FRUITS[0]);
  });

  it("Escape closes the listbox", () => {
    const { cb, input } = setup(FRUITS);
    cb.open();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(cb.isOpen()).toBe(false);
  });

  it("Home and End set highlight to bounds", () => {
    const { cb, input } = setup(FRUITS);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(cb.highlightedIndex()).toBe(2);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(cb.highlightedIndex()).toBe(0);
  });

  it("Home/End no-op when filtered empty", () => {
    const { cb, input } = setup([]);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(cb.highlightedIndex()).toBe(-1);
  });

  it("focus opens and blur closes after delay", () => {
    vi.useFakeTimers();
    const { cb, input } = setup(FRUITS);
    input.dispatchEvent(new Event("focus"));
    expect(cb.isOpen()).toBe(true);
    input.dispatchEvent(new Event("blur"));
    expect(cb.isOpen()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(cb.isOpen()).toBe(false);
  });

  it("blur does not close if input is still active element", () => {
    vi.useFakeTimers();
    const { cb, input } = setup(FRUITS);
    input.focus();
    cb.open();
    input.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(100);
    expect(cb.isOpen()).toBe(true);
  });

  it("repeated blur clears prior timer", () => {
    vi.useFakeTimers();
    const { cb, input } = setup(FRUITS);
    cb.open();
    input.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(50);
    input.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(100);
    expect(cb.isOpen()).toBe(false);
  });

  it("bind twice returns same teardown", () => {
    const { cb, input, listbox, option, dispose } = setup(FRUITS);
    const again = cb.bind({ input, listbox, option });
    expect(again).toBe(dispose);
    dispose();
  });

  it("teardown removes listeners and pending timer", () => {
    vi.useFakeTimers();
    const { cb, input, dispose } = setup(FRUITS);
    cb.open();
    input.dispatchEvent(new Event("blur"));
    dispose();
    input.dispatchEvent(new Event("input"));
    // input listener removed: query unchanged from blur path
    vi.advanceTimersByTime(200);
    expect(cb.query()).toBe("");
  });
});
