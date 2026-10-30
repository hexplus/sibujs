import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetDialogStack, dialog } from "../src/ui/dialog";
import { accordion } from "../src/widgets/Accordion";
import { combobox } from "../src/widgets/Combobox";
import { isWidgetKeyEvent, widgetKeyOwner } from "../src/widgets/keyOwnership";
import { popover } from "../src/widgets/Popover";
import { select } from "../src/widgets/Select";
import { selectMenu } from "../src/widgets/selectMenu";
import { tabs } from "../src/widgets/Tabs";
import { tooltip } from "../src/widgets/Tooltip";

// ---------------------------------------------------------------------------
// Keyboard ownership: a key a widget acts on is CLAIMED, so a page-level
// shortcut handler can tell it apart (`isWidgetKeyEvent`), and an enclosing
// widget or dialog does not act on it a second time.
// ---------------------------------------------------------------------------

let seenByPage: string[];
const pageHandler = (e: KeyboardEvent) => {
  if (!isWidgetKeyEvent(e)) seenByPage.push(e.key);
};

beforeEach(() => {
  document.body.innerHTML = "";
  seenByPage = [];
  document.addEventListener("keydown", pageHandler);
});

afterEach(() => {
  document.removeEventListener("keydown", pageHandler);
  __resetDialogStack();
  document.body.innerHTML = "";
});

function press(target: Element, key: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, parent: Element = document.body): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  parent.appendChild(node);
  return node;
}

describe("every widget claims the keys it handles", () => {
  it("tabs", () => {
    const t = tabs({
      tabs: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });
    const list = el("div");
    const a = el("button", list);
    const b = el("button", list);
    t.bind({ tablist: list, tabs: { a, b } });
    expect(widgetKeyOwner(press(a, "ArrowRight"))).toBe("tabs");
    expect(isWidgetKeyEvent(press(a, "x"))).toBe(false);
    expect(seenByPage).toEqual(["x"]);
  });

  it("accordion", () => {
    const acc = accordion({ items: [{ id: "one" }] } as never);
    const trig = el("button");
    const panel = el("div");
    acc.bind({ triggers: { one: trig }, panels: { one: panel } } as never);
    expect(widgetKeyOwner(press(trig, "Enter"))).toBe("accordion");
    expect(seenByPage).toEqual([]);
  });

  it("select (listbox), including typeahead", () => {
    const s = select({ items: ["apple", "banana"] });
    const list = el("ul");
    const opts = [el("li", list), el("li", list)];
    s.bind({ listbox: list, option: (_x, i) => opts[i] });
    expect(widgetKeyOwner(press(list, "ArrowDown"))).toBe("select");
    expect(widgetKeyOwner(press(list, "b"))).toBe("select");
    expect(seenByPage).toEqual([]);
  });

  it("combobox", () => {
    const c = combobox({ items: ["a", "b"] });
    const input = el("input");
    const list = el("ul");
    c.bind({ input, listbox: list, option: () => null });
    expect(widgetKeyOwner(press(input, "ArrowDown"))).toBe("combobox");
    // Typing in the input is text entry, not a widget key.
    expect(isWidgetKeyEvent(press(input, "q"))).toBe(false);
  });

  it("popover and tooltip claim Escape only while open", () => {
    const p = popover();
    const trigger = el("button");
    const pop = el("div");
    p.bind({ trigger, popover: pop });
    expect(isWidgetKeyEvent(press(pop, "Escape"))).toBe(false);
    p.open();
    expect(widgetKeyOwner(press(pop, "Escape"))).toBe("popover");

    const t = tooltip();
    const tt = el("button");
    const tip = el("div");
    t.bind({ trigger: tt, tooltip: tip });
    t.show();
    expect(widgetKeyOwner(press(tt, "Escape"))).toBe("tooltip");
  });
});

describe("nested ownership", () => {
  function menuIn(parent: Element) {
    const trigger = el("button", parent);
    const list = el("ul", parent);
    const opts = ["a", "b", "c"].map(() => el("li", list));
    const menu = selectMenu({ items: ["a", "b", "c"] });
    menu.bind({ trigger, listbox: list, option: (_x, i) => opts[i] });
    return { menu, trigger };
  }

  it("Escape in a select menu inside a popover closes the menu, not the popover", () => {
    const p = popover();
    const ptrigger = el("button");
    const pop = el("div");
    p.bind({ trigger: ptrigger, popover: pop });
    p.open();
    const { menu, trigger } = menuIn(pop);
    menu.open();

    press(trigger, "Escape");
    expect(menu.isOpen()).toBe(false);
    expect(p.isOpen()).toBe(true);

    // The next Escape is the popover's.
    press(trigger, "Escape");
    expect(p.isOpen()).toBe(false);
  });

  it("Escape in a select menu inside a dialog() closes the menu, not the dialog", () => {
    const d = dialog();
    d.open();
    const { menu, trigger } = menuIn(el("div"));
    menu.open();

    press(trigger, "Escape");
    expect(menu.isOpen()).toBe(false);
    expect(d.isOpen()).toBe(true);

    press(trigger, "Escape");
    expect(d.isOpen()).toBe(false);
  });

  it("keys a select menu inside tabs handles do not switch tabs; keys it does not handle still do", () => {
    const t = tabs({
      tabs: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    });
    const list = el("div");
    const a = el("button", list);
    const b = el("button", list);
    t.bind({ tablist: list, tabs: { a, b } });
    const { menu, trigger } = menuIn(list);
    menu.open();
    press(trigger, "ArrowDown");
    press(trigger, "ArrowUp");
    expect(t.activeTab()).toBe("a");
    // ArrowRight is not part of the select-only pattern, so it is unclaimed.
    press(trigger, "ArrowRight");
    expect(t.activeTab()).toBe("b");
  });
});
