import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signal } from "../src/core/signals/signal";
import { isWidgetKeyEvent, widgetKeyOwner } from "../src/widgets/keyOwnership";
import { selectMenu } from "../src/widgets/selectMenu";

// ---------------------------------------------------------------------------
// selectMenu(): the WAI-ARIA APG "select-only combobox" — a trigger that opens
// a popup listbox, navigated through aria-activedescendant.
// ---------------------------------------------------------------------------

interface Font {
  label: string;
  disabled?: boolean;
}

const FONTS: Font[] = [
  { label: "Arial" },
  { label: "Bodoni", disabled: true },
  { label: "Courier" },
  { label: "Didot" },
  { label: "Futura" },
  { label: "Garamond" },
  { label: "Gill Sans" },
  { label: "Helvetica" },
  { label: "Inter" },
  { label: "Jost" },
  { label: "Lato" },
  { label: "Merriweather" },
  { label: "Times New Roman" },
  { label: "Verdana" },
];

let trigger: HTMLButtonElement;
let listbox: HTMLUListElement;
let optionEls: HTMLLIElement[];
let outside: HTMLButtonElement;
let pageKeys: KeyboardEvent[];
const onPageKey = (e: KeyboardEvent) => {
  if (!isWidgetKeyEvent(e)) pageKeys.push(e);
};

function build(items: Font[] = FONTS): void {
  trigger = document.createElement("button");
  trigger.textContent = "Font";
  listbox = document.createElement("ul");
  optionEls = items.map((f) => {
    const li = document.createElement("li");
    const inner = document.createElement("span");
    inner.textContent = f.label;
    li.appendChild(inner);
    listbox.appendChild(li);
    return li;
  });
  outside = document.createElement("button");
  outside.textContent = "outside";
  document.body.append(trigger, listbox, outside);
}

function key(k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  trigger.dispatchEvent(e);
  return e;
}

function make(extra: Partial<Parameters<typeof selectMenu<Font>>[0]> = {}) {
  const [font, setFont] = signal<Font | null>(FONTS[0]);
  const onChange = vi.fn((f: Font) => setFont(f));
  const menu = selectMenu<Font>({
    items: FONTS,
    value: () => font(),
    onChange,
    itemToString: (f) => f.label,
    isDisabled: (f) => f.disabled === true,
    ...extra,
  });
  const dispose = menu.bind({ trigger, listbox, option: (_f, i) => optionEls[i] ?? null });
  return { menu, dispose, font, setFont, onChange };
}

const activeId = () => trigger.getAttribute("aria-activedescendant");
const activeLabel = () => document.getElementById(activeId() ?? "")?.textContent ?? null;

beforeEach(() => {
  document.body.innerHTML = "";
  pageKeys = [];
  document.addEventListener("keydown", onPageKey);
  build();
  trigger.focus();
});

afterEach(() => {
  document.removeEventListener("keydown", onPageKey);
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("selectMenu: ARIA wiring", () => {
  it("sets roles, ids and state on trigger, listbox and options", () => {
    make();
    expect(trigger.getAttribute("role")).toBe("combobox");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-controls")).toBe(listbox.id);
    expect(listbox.getAttribute("role")).toBe("listbox");
    expect(listbox.hidden).toBe(true);
    expect(optionEls.every((o) => o.getAttribute("role") === "option" && o.id !== "")).toBe(true);
    expect(optionEls[0].getAttribute("aria-selected")).toBe("true");
    expect(optionEls[2].getAttribute("aria-selected")).toBe("false");
    expect(optionEls[1].getAttribute("aria-disabled")).toBe("true");
    expect(activeId()).toBeNull();
  });

  it("is idempotent per trigger", () => {
    const { menu, dispose } = make();
    expect(menu.bind({ trigger, listbox, option: (_f, i) => optionEls[i] })).toBe(dispose);
  });
});

describe("selectMenu: keyboard while closed", () => {
  for (const k of ["ArrowDown", "ArrowUp", "Enter", " "]) {
    it(`${JSON.stringify(k)} opens on the selected option without changing the value`, () => {
      const { menu, onChange } = make();
      key(k);
      expect(menu.isOpen()).toBe(true);
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(listbox.hidden).toBe(false);
      expect(activeLabel()).toBe("Arial");
      expect(onChange).not.toHaveBeenCalled();
    });
  }

  it("Home opens on the first option, End on the last", () => {
    const { menu } = make();
    key("End");
    expect(menu.isOpen()).toBe(true);
    expect(activeLabel()).toBe("Verdana");
    menu.close();
    key("Home");
    expect(activeLabel()).toBe("Arial");
  });

  it("a printable character opens and jumps to the first match", () => {
    const { menu } = make();
    key("g");
    expect(menu.isOpen()).toBe(true);
    expect(activeLabel()).toBe("Garamond");
  });

  it("Escape while closed is left to the page", () => {
    make();
    const e = key("Escape");
    expect(isWidgetKeyEvent(e)).toBe(false);
    expect(pageKeys.map((p) => p.key)).toEqual(["Escape"]);
  });
});

describe("selectMenu: keyboard while open", () => {
  it("ArrowDown / ArrowUp move, skipping disabled options, and stop at the ends", () => {
    const { menu } = make();
    menu.open();
    key("ArrowDown");
    expect(activeLabel()).toBe("Courier"); // Bodoni is disabled
    key("ArrowUp");
    expect(activeLabel()).toBe("Arial");
    key("ArrowUp");
    expect(activeLabel()).toBe("Arial");
    key("End");
    key("ArrowDown");
    expect(activeLabel()).toBe("Verdana");
  });

  it("Home / End move to the first / last enabled option", () => {
    const { menu } = make({ isDisabled: (f) => f.label === "Arial" || f.label === "Verdana" });
    menu.open();
    key("End");
    expect(activeLabel()).toBe("Times New Roman");
    key("Home");
    expect(activeLabel()).toBe("Bodoni");
  });

  it("PageDown / PageUp jump by pageSize and clamp", () => {
    const { menu } = make({ pageSize: 5 });
    menu.open();
    key("PageDown");
    expect(activeLabel()).toBe("Garamond");
    key("PageDown");
    expect(activeLabel()).toBe("Lato");
    key("PageDown");
    expect(activeLabel()).toBe("Verdana");
    key("PageUp");
    expect(activeLabel()).toBe("Inter");
    key("PageUp");
    key("PageUp");
    expect(activeLabel()).toBe("Arial");
  });

  it("PageDown landing on a disabled option keeps going", () => {
    const { menu } = make({ pageSize: 1 });
    menu.open();
    key("PageDown");
    expect(activeLabel()).toBe("Courier");
  });

  it("Enter commits the active option and closes", () => {
    const { menu, onChange, font } = make();
    menu.open();
    key("ArrowDown");
    key("Enter");
    expect(onChange).toHaveBeenCalledWith(FONTS[2]);
    expect(font()).toBe(FONTS[2]);
    expect(menu.isOpen()).toBe(false);
    expect(optionEls[2].getAttribute("aria-selected")).toBe("true");
    expect(optionEls[0].getAttribute("aria-selected")).toBe("false");
  });

  it("Space commits too", () => {
    const { menu, onChange } = make();
    menu.open();
    key("ArrowDown");
    key(" ");
    expect(onChange).toHaveBeenCalledWith(FONTS[2]);
    expect(menu.isOpen()).toBe(false);
  });

  it("Alt+ArrowUp commits and closes", () => {
    const { menu, onChange } = make();
    menu.open();
    key("ArrowDown");
    key("ArrowUp", { altKey: true });
    expect(onChange).toHaveBeenCalledWith(FONTS[2]);
    expect(menu.isOpen()).toBe(false);
  });

  it("Escape closes without changing the value, and is not seen by the page", () => {
    const { menu, onChange } = make();
    menu.open();
    key("ArrowDown");
    const e = key("Escape");
    expect(menu.isOpen()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(widgetKeyOwner(e)).toBe("selectMenu");
    expect(pageKeys).toEqual([]);
    expect(document.activeElement).toBe(trigger);
  });

  it("Tab commits the active option and lets focus move on", () => {
    const { menu, onChange } = make();
    menu.open();
    key("ArrowDown");
    const e = key("Tab");
    expect(onChange).toHaveBeenCalledWith(FONTS[2]);
    expect(menu.isOpen()).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    expect(isWidgetKeyEvent(e)).toBe(false);
  });

  it("typeahead matches a multi-character prefix and resets after 500 ms", () => {
    vi.useFakeTimers();
    const { menu } = make();
    menu.open();
    key("g");
    key("i");
    expect(activeLabel()).toBe("Gill Sans");
    vi.advanceTimersByTime(600);
    key("l");
    expect(activeLabel()).toBe("Lato");
  });

  it("typeahead with a repeated letter cycles through matches", () => {
    vi.useFakeTimers();
    const { menu } = make();
    menu.open();
    key("g");
    expect(activeLabel()).toBe("Garamond");
    key("g");
    expect(activeLabel()).toBe("Gill Sans");
    key("g");
    expect(activeLabel()).toBe("Garamond");
  });

  it("Space continues a typeahead string instead of committing", () => {
    vi.useFakeTimers();
    const { menu, onChange } = make();
    menu.open();
    for (const c of "times") key(c);
    key(" ");
    key("n");
    expect(activeLabel()).toBe("Times New Roman");
    expect(onChange).not.toHaveBeenCalled();
    expect(menu.isOpen()).toBe(true);
  });

  it("typeahead skips disabled options", () => {
    const { menu } = make();
    menu.open();
    key("b");
    expect(activeLabel()).toBe("Arial");
  });

  it("navigation keys never reach a page-level listener", () => {
    const { menu } = make();
    menu.open();
    for (const k of ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp", "x"]) {
      const e = key(k);
      expect(e.defaultPrevented).toBe(true);
      expect(isWidgetKeyEvent(e)).toBe(true);
    }
    expect(pageKeys).toEqual([]);
  });

  it("modifier shortcuts (Ctrl/Meta) are left alone", () => {
    const { menu } = make();
    menu.open();
    const e = key("a", { ctrlKey: true });
    expect(isWidgetKeyEvent(e)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it("scrolls the active option into view when it changes", () => {
    const spy = vi.fn();
    for (const o of optionEls) (o as unknown as { scrollIntoView: () => void }).scrollIntoView = spy;
    const { menu } = make();
    menu.open();
    expect(spy).toHaveBeenCalledTimes(1);
    key("ArrowDown");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith({ block: "nearest" });
  });
});

describe("selectMenu: pointer, focus and outside changes", () => {
  it("clicking the trigger toggles", () => {
    const { menu } = make();
    trigger.click();
    expect(menu.isOpen()).toBe(true);
    trigger.click();
    expect(menu.isOpen()).toBe(false);
  });

  it("clicking an option (or content inside it) commits it and returns focus to the trigger", () => {
    const { menu, onChange } = make();
    menu.open();
    outside.focus();
    optionEls[3].querySelector("span")!.click();
    expect(onChange).toHaveBeenCalledWith(FONTS[3]);
    expect(menu.isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("clicking a disabled option does nothing", () => {
    const { menu, onChange } = make();
    menu.open();
    optionEls[1].click();
    expect(onChange).not.toHaveBeenCalled();
    expect(menu.isOpen()).toBe(true);
  });

  it("pressing inside the listbox does not move focus off the trigger", () => {
    const { menu } = make();
    menu.open();
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    optionEls[2].dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });

  it("hovering an option makes it active", () => {
    const { menu } = make();
    menu.open();
    optionEls[4].dispatchEvent(new Event("pointermove", { bubbles: true }));
    expect(activeLabel()).toBe("Futura");
  });

  it("an outside press closes without committing", () => {
    const { menu, onChange } = make();
    menu.open();
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu.isOpen()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a press on the trigger or listbox is not an outside press", () => {
    const { menu } = make();
    menu.open();
    optionEls[0].dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu.isOpen()).toBe(true);
  });

  it("focus leaving the trigger closes the list", () => {
    const { menu } = make();
    menu.open();
    outside.focus();
    expect(menu.isOpen()).toBe(false);
  });

  it("a value changed from outside while open updates aria-selected and keeps the active option", () => {
    const { menu, setFont } = make();
    menu.open();
    key("ArrowDown");
    setFont(FONTS[5]);
    expect(menu.isOpen()).toBe(true);
    expect(optionEls[5].getAttribute("aria-selected")).toBe("true");
    expect(optionEls[0].getAttribute("aria-selected")).toBe("false");
    expect(activeLabel()).toBe("Courier");
  });

  it("opens on the newly selected option after an outside change", () => {
    const { menu, setFont } = make();
    setFont(FONTS[7]);
    menu.open();
    expect(activeLabel()).toBe("Helvetica");
  });

  it("uncontrolled: keeps its own value seeded by defaultValue", () => {
    const onChange = vi.fn();
    const menu = selectMenu<Font>({ items: FONTS, defaultValue: FONTS[2], onChange, itemToString: (f) => f.label });
    menu.bind({ trigger, listbox, option: (_f, i) => optionEls[i] });
    expect(menu.value()).toBe(FONTS[2]);
    menu.open();
    key("ArrowDown");
    key("Enter");
    expect(menu.value()).toBe(FONTS[3]);
    expect(onChange).toHaveBeenCalledWith(FONTS[3]);
  });

  it("select() ignores a disabled item", () => {
    const { menu, onChange } = make();
    menu.select(FONTS[1]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reactive items: options added later are wired", () => {
    const [items, setItems] = signal<Font[]>(FONTS.slice(0, 2));
    const menu = selectMenu<Font>({ items: () => items(), itemToString: (f) => f.label });
    menu.bind({ trigger, listbox, option: (_f, i) => optionEls[i] ?? null });
    expect(optionEls[3].getAttribute("role")).toBeNull();
    setItems(FONTS.slice(0, 5));
    expect(optionEls[3].getAttribute("role")).toBe("option");
  });
});

describe("selectMenu: dispose", () => {
  it("restores every attribute it touched and removes its listeners", () => {
    trigger.setAttribute("aria-haspopup", "menu");
    listbox.id = "my-list";
    listbox.hidden = false;
    optionEls[0].id = "first";
    optionEls[2].setAttribute("aria-selected", "custom");
    const snapshot = (el: Element) => Array.from(el.attributes, (a) => `${a.name}=${a.value}`).sort();
    const before = [trigger, listbox, ...optionEls].map(snapshot);

    const { menu, dispose } = make();
    menu.open();
    key("ArrowDown");
    dispose();

    expect([trigger, listbox, ...optionEls].map(snapshot)).toEqual(before);
    expect(listbox.hidden).toBe(false);
    // Listeners are gone: keys and clicks no longer drive the menu. (The
    // headless state itself is left as it was; close it to observe that.)
    menu.close();
    key("ArrowDown");
    trigger.click();
    expect(menu.isOpen()).toBe(false);
  });

  it("dispose is idempotent", () => {
    const { dispose } = make();
    dispose();
    expect(() => dispose()).not.toThrow();
  });
});
