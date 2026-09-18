import { afterEach, describe, expect, it } from "vitest";
import { effect } from "../src/core/signals/effect";
import { createListbox } from "../src/ui/a11yPrimitives";

// ---------------------------------------------------------------------------
// Multi-select listbox state is a collection, not a CSV string.
//
// THE DEFECT: multiple selection lived in one comma-joined string that was
// re-split on every toggle. A value containing a comma ("a,b") collided with
// the pair "a" + "b", could not be deselected, and marked unrelated options
// selected; `filter(Boolean)` dropped the empty-string value entirely.
// ---------------------------------------------------------------------------

const VALUES = ["a,b", "", "a", "b"];

let container: HTMLElement;

afterEach(() => {
  container?.remove();
});

function makeListbox(values: string[]): HTMLElement {
  const el = document.createElement("ul");
  for (const value of values) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.value = value;
    li.textContent = value === "" ? "(empty)" : value;
    el.appendChild(li);
  }
  document.body.appendChild(el);
  return el;
}

function option(value: string): HTMLElement {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (o) => o.dataset.value === value,
  ) as HTMLElement;
}

function click(value: string): void {
  option(value).dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function ariaSelected(): string[] {
  return VALUES.filter((v) => option(v).getAttribute("aria-selected") === "true");
}

describe("createListbox multiple mode: selectedValues", () => {
  for (const value of VALUES) {
    it(`selects and deselects ${JSON.stringify(value)} independently`, () => {
      container = makeListbox(VALUES);
      const lb = createListbox(container, { multiple: true });

      click(value);
      expect(lb.selectedValues()).toEqual([value]);
      expect(ariaSelected()).toEqual([value]);

      click(value);
      expect(lb.selectedValues()).toEqual([]);
      expect(ariaSelected()).toEqual([]);
      lb.dispose();
    });
  }

  it('"a,b" is distinct from "a" and "b" across interleaved toggles', () => {
    container = makeListbox(VALUES);
    const lb = createListbox(container, { multiple: true });

    click("a,b");
    click("a");
    expect(lb.selectedValues()).toEqual(["a,b", "a"]);
    expect(ariaSelected()).toEqual(["a,b", "a"]);

    click("b");
    click("a,b");
    expect(lb.selectedValues()).toEqual(["a", "b"]);
    expect(ariaSelected()).toEqual(["a", "b"]);

    click("");
    click("a");
    expect(lb.selectedValues()).toEqual(["b", ""]);
    expect(ariaSelected()).toEqual(["", "b"]);
    lb.dispose();
  });

  it("selects every value together and releases them one by one", () => {
    container = makeListbox(VALUES);
    const lb = createListbox(container, { multiple: true });

    for (const v of VALUES) click(v);
    expect(lb.selectedValues()).toEqual(VALUES);
    expect(ariaSelected()).toEqual(VALUES);

    for (const v of VALUES) {
      click(v);
      expect(lb.selectedValues()).not.toContain(v);
      expect(option(v).getAttribute("aria-selected")).toBe("false");
    }
    expect(lb.selectedValues()).toEqual([]);
    lb.dispose();
  });

  it("keyboard selection supports the empty-string value", () => {
    container = makeListbox(["", "x"]);
    const lb = createListbox(container, { multiple: true });

    container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(lb.selectedValues()).toEqual([""]);
    container.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(lb.selectedValues()).toEqual([]);
    lb.dispose();
  });

  it("an option without data-value is never marked selected by the empty value", () => {
    container = makeListbox([""]);
    const bare = document.createElement("li");
    bare.setAttribute("role", "option");
    container.appendChild(bare);
    const lb = createListbox(container, { multiple: true });

    click("");
    expect(lb.selectedValues()).toEqual([""]);
    expect(bare.getAttribute("aria-selected")).toBe("false");
    lb.dispose();
  });

  it("selectedValues is reactive and returns a new array per change", () => {
    container = makeListbox(VALUES);
    const lb = createListbox(container, { multiple: true });
    const seen: Array<readonly string[]> = [];
    const stop = effect(() => {
      seen.push(lb.selectedValues());
    });

    click("a,b");
    click("");

    expect(seen).toEqual([[], ["a,b"], ["a,b", ""]]);
    expect(seen[1]).not.toBe(seen[2]);
    stop();
    lb.dispose();
  });

  it("keeps the CSV selectedValue view for compatibility", () => {
    container = makeListbox(["a", "b"]);
    const lb = createListbox(container, { multiple: true });
    expect(lb.selectedValue()).toBeNull();
    click("a");
    click("b");
    expect(lb.selectedValue()).toBe("a,b");
    lb.dispose();
  });
});

describe("createListbox single mode: selectedValues", () => {
  it("holds at most the one selected value, including special values", () => {
    container = makeListbox(VALUES);
    const lb = createListbox(container);
    expect(lb.selectedValues()).toEqual([]);

    click("a,b");
    expect(lb.selectedValues()).toEqual(["a,b"]);
    expect(lb.selectedValue()).toBe("a,b");
    expect(ariaSelected()).toEqual(["a,b"]);

    click("");
    expect(lb.selectedValues()).toEqual([""]);
    expect(lb.selectedValue()).toBe("");
    expect(ariaSelected()).toEqual([""]);
    lb.dispose();
  });
});
