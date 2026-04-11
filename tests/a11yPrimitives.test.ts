import { describe, expect, it } from "vitest";
import { createDialogAria, createFocusManager, createListbox } from "../src/ui/a11yPrimitives";

describe("createFocusManager", () => {
  it("focusFirst focuses the first matching descendant", () => {
    const container = document.createElement("div");
    container.innerHTML = '<button id="a">A</button><button id="b">B</button><button id="c">C</button>';
    document.body.appendChild(container);

    const mgr = createFocusManager(container);
    mgr.focusFirst();
    expect(document.activeElement?.id).toBe("a");
    mgr.focusLast();
    expect(document.activeElement?.id).toBe("c");

    document.body.removeChild(container);
  });

  it("focusNext wraps around when loop is true", () => {
    const container = document.createElement("div");
    container.innerHTML = '<button id="x">X</button><button id="y">Y</button>';
    document.body.appendChild(container);

    const mgr = createFocusManager(container, { loop: true });
    (container.querySelector("#y") as HTMLButtonElement).focus();
    mgr.focusNext();
    expect(document.activeElement?.id).toBe("x");

    document.body.removeChild(container);
  });

  it("focusPrev stays put when loop is false at the first element", () => {
    const container = document.createElement("div");
    container.innerHTML = '<button id="x">X</button><button id="y">Y</button>';
    document.body.appendChild(container);

    const mgr = createFocusManager(container, { loop: false });
    (container.querySelector("#x") as HTMLButtonElement).focus();
    mgr.focusPrev();
    expect(document.activeElement?.id).toBe("x");

    document.body.removeChild(container);
  });
});

describe("createListbox", () => {
  function buildContainer() {
    const container = document.createElement("ul");
    container.innerHTML = `
      <li role="option" data-value="a">Apple</li>
      <li role="option" data-value="b">Banana</li>
      <li role="option" data-value="c">Cherry</li>
    `;
    document.body.appendChild(container);
    return container;
  }

  it("applies role=listbox and gives every option a stable id", () => {
    const c = buildContainer();
    createListbox(c);
    expect(c.getAttribute("role")).toBe("listbox");
    const opts = Array.from(c.querySelectorAll('[role="option"]'));
    for (const o of opts) expect(o.id).not.toBe("");
    document.body.removeChild(c);
  });

  it("Arrow keys move active descendant and aria-activedescendant reflects it", () => {
    const c = buildContainer();
    const lb = createListbox(c);
    c.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(lb.activeValue()).toBe("a");
    c.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(lb.activeValue()).toBe("b");
    expect(c.getAttribute("aria-activedescendant")).toBeTruthy();
    document.body.removeChild(c);
  });

  it("Enter commits the active option", () => {
    const c = buildContainer();
    const selected: string[] = [];
    createListbox(c, { onSelect: (v) => selected.push(v) });
    c.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    c.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(selected).toEqual(["a"]);
    document.body.removeChild(c);
  });

  it("clicking an option selects it", () => {
    const c = buildContainer();
    const selected: string[] = [];
    createListbox(c, { onSelect: (v) => selected.push(v) });
    const banana = c.querySelector('[data-value="b"]') as HTMLElement;
    banana.click();
    expect(selected).toEqual(["b"]);
    document.body.removeChild(c);
  });
});

describe("createDialogAria", () => {
  it("applies role + aria-modal + labelledby/describedby", () => {
    const el = document.createElement("div");
    const aria = createDialogAria(el);
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.getAttribute("aria-modal")).toBe("true");
    expect(el.getAttribute("aria-labelledby")).toBe(aria.titleId);
    expect(el.getAttribute("aria-describedby")).toBe(aria.descriptionId);
    expect(el.getAttribute("tabindex")).toBe("-1");
  });

  it("uses role=alertdialog when alert option is true", () => {
    const el = document.createElement("div");
    createDialogAria(el, { alert: true });
    expect(el.getAttribute("role")).toBe("alertdialog");
  });

  it("respects explicit labelledBy/describedBy ids", () => {
    const el = document.createElement("div");
    const aria = createDialogAria(el, { labelledBy: "my-title", describedBy: "my-desc" });
    expect(aria.titleId).toBe("my-title");
    expect(aria.descriptionId).toBe("my-desc");
  });
});
