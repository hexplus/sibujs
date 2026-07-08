import { afterEach, describe, expect, it, vi } from "vitest";
import { createDialogAria, createFocusManager, createListbox } from "../src/ui/a11yPrimitives";

function makeFocusableContainer(): { container: HTMLElement; buttons: HTMLButtonElement[] } {
  const container = document.createElement("div");
  const buttons: HTMLButtonElement[] = [];
  for (let i = 0; i < 3; i++) {
    const b = document.createElement("button");
    b.textContent = `b${i}`;
    container.appendChild(b);
    buttons.push(b);
  }
  document.body.appendChild(container);
  return { container, buttons };
}

describe("createFocusManager", () => {
  let container: HTMLElement;
  afterEach(() => container?.remove());

  it("focusFirst and focusLast move focus to ends", () => {
    const made = makeFocusableContainer();
    container = made.container;
    const fm = createFocusManager(container);
    fm.focusFirst();
    expect(document.activeElement).toBe(made.buttons[0]);
    fm.focusLast();
    expect(document.activeElement).toBe(made.buttons[2]);
  });

  it("focusNext advances and wraps with loop", () => {
    const made = makeFocusableContainer();
    container = made.container;
    const fm = createFocusManager(container);
    made.buttons[0].focus();
    fm.focusNext();
    expect(document.activeElement).toBe(made.buttons[1]);
    made.buttons[2].focus();
    fm.focusNext();
    expect(document.activeElement).toBe(made.buttons[0]);
  });

  it("focusNext at the end does not wrap when loop is false", () => {
    const made = makeFocusableContainer();
    container = made.container;
    const fm = createFocusManager(container, { loop: false });
    made.buttons[2].focus();
    fm.focusNext();
    expect(document.activeElement).toBe(made.buttons[2]);
  });

  it("focusNext focuses first when active element is outside", () => {
    const made = makeFocusableContainer();
    container = made.container;
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const fm = createFocusManager(container);
    fm.focusNext();
    expect(document.activeElement).toBe(made.buttons[0]);
    outside.remove();
  });

  it("focusPrev retreats and wraps with loop", () => {
    const made = makeFocusableContainer();
    container = made.container;
    const fm = createFocusManager(container);
    made.buttons[2].focus();
    fm.focusPrev();
    expect(document.activeElement).toBe(made.buttons[1]);
    made.buttons[0].focus();
    fm.focusPrev();
    expect(document.activeElement).toBe(made.buttons[2]);
  });

  it("focusPrev at the start does not wrap when loop is false", () => {
    const made = makeFocusableContainer();
    container = made.container;
    const fm = createFocusManager(container, { loop: false });
    made.buttons[0].focus();
    fm.focusPrev();
    expect(document.activeElement).toBe(made.buttons[0]);
  });

  it("focusPrev focuses last when active element is outside", () => {
    const made = makeFocusableContainer();
    container = made.container;
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const fm = createFocusManager(container);
    fm.focusPrev();
    expect(document.activeElement).toBe(made.buttons[2]);
    outside.remove();
  });

  it("handles empty containers without throwing", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const fm = createFocusManager(container);
    expect(() => {
      fm.focusFirst();
      fm.focusLast();
      fm.focusNext();
      fm.focusPrev();
    }).not.toThrow();
    expect(fm.items()).toEqual([]);
  });
});

function makeListbox(values: string[]): HTMLElement {
  const ul = document.createElement("ul");
  for (const v of values) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset.value = v;
    li.textContent = v;
    ul.appendChild(li);
  }
  document.body.appendChild(ul);
  return ul;
}

describe("createListbox", () => {
  let container: HTMLElement;
  afterEach(() => container?.remove());

  it("sets role, tabindex, and stamps option ids", () => {
    container = makeListbox(["a", "b"]);
    const lb = createListbox(container);
    expect(container.getAttribute("role")).toBe("listbox");
    expect(container.getAttribute("tabindex")).toBe("0");
    const opts = container.querySelectorAll('[role="option"]');
    expect(opts[0].id).not.toBe("");
    lb.dispose();
  });

  it("ArrowDown/Up navigation updates active value and aria-activedescendant", () => {
    container = makeListbox(["a", "b", "c"]);
    const lb = createListbox(container);

    container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(lb.activeValue()).toBe("a");
    expect(lb.activeDescendantId()).not.toBeNull();
    expect(container.getAttribute("aria-activedescendant")).not.toBe("");

    container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(lb.activeValue()).toBe("b");

    container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(lb.activeValue()).toBe("a");

    // Wrap backward from first to last.
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(lb.activeValue()).toBe("c");
    lb.dispose();
  });

  it("Home and End jump to first/last", () => {
    container = makeListbox(["a", "b", "c"]);
    const lb = createListbox(container);
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(lb.activeValue()).toBe("c");
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(lb.activeValue()).toBe("a");
    lb.dispose();
  });

  it("Enter selects the active option (single-select)", () => {
    container = makeListbox(["a", "b"]);
    const onSelect = vi.fn();
    const lb = createListbox(container, { onSelect });
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(lb.selectedValue()).toBe("a");
    expect(onSelect).toHaveBeenCalledWith("a");
    expect(container.querySelector('[data-value="a"]')?.getAttribute("aria-selected")).toBe("true");
    lb.dispose();
  });

  it("Space does nothing when there is no active option", () => {
    container = makeListbox(["a"]);
    const onSelect = vi.fn();
    const lb = createListbox(container, { onSelect });
    container.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(onSelect).not.toHaveBeenCalled();
    lb.dispose();
  });

  it("multiple selection toggles values into a CSV", () => {
    container = makeListbox(["a", "b", "c"]);
    const lb = createListbox(container, { multiple: true });
    expect(container.getAttribute("aria-multiselectable")).toBe("true");

    container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(lb.selectedValue()).toBe("a,b");

    // Toggle 'a' off again.
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(lb.selectedValue()).toBe("b");
    lb.dispose();
  });

  it("click on an option selects and highlights it", () => {
    container = makeListbox(["a", "b"]);
    const onSelect = vi.fn();
    const lb = createListbox(container, { onSelect });
    const optB = container.querySelector('[data-value="b"]') as HTMLElement;
    optB.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(lb.activeValue()).toBe("b");
    expect(lb.selectedValue()).toBe("b");
    expect(onSelect).toHaveBeenCalledWith("b");
    lb.dispose();
  });

  it("click outside any option is ignored", () => {
    container = makeListbox(["a"]);
    const onSelect = vi.fn();
    const lb = createListbox(container, { onSelect });
    container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect).not.toHaveBeenCalled();
    lb.dispose();
  });

  it("respects a custom option selector", () => {
    container = document.createElement("ul");
    const li = document.createElement("li");
    li.className = "opt";
    li.dataset.value = "x";
    container.appendChild(li);
    document.body.appendChild(container);
    const lb = createListbox(container, { optionSelector: ".opt" });
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(lb.activeValue()).toBe("x");
    lb.dispose();
  });
});

describe("createDialogAria", () => {
  it("sets dialog role, modal, and generated ids", () => {
    const el = document.createElement("div");
    const handle = createDialogAria(el);
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("aria-modal")).toBe("true");
    expect(el.getAttribute("aria-labelledby")).toBe(handle.titleId);
    expect(el.getAttribute("aria-describedby")).toBe(handle.descriptionId);
    expect(el.getAttribute("tabindex")).toBe("-1");
  });

  it("uses alertdialog role and honors provided ids and modal=false", () => {
    const el = document.createElement("div");
    el.setAttribute("tabindex", "0");
    const handle = createDialogAria(el, {
      alert: true,
      modal: false,
      labelledBy: "my-title",
      describedBy: "my-desc",
    });
    expect(el.getAttribute("role")).toBe("alertdialog");
    expect(el.hasAttribute("aria-modal")).toBe(false);
    expect(handle.titleId).toBe("my-title");
    expect(handle.descriptionId).toBe("my-desc");
    // Existing tabindex is preserved.
    expect(el.getAttribute("tabindex")).toBe("0");
  });
});
