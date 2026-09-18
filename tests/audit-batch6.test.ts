import { afterEach, describe, expect, it, vi } from "vitest";
import { draggable, dropZone } from "../src/browser/dragDrop";
import { pointerLock } from "../src/browser/pointerLock";
import { signal } from "../src/core/signals/signal";
import { accordion } from "../src/widgets/Accordion";
import { datePicker } from "../src/widgets/datePicker";
import { tabs } from "../src/widgets/Tabs";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const box = (tag = "div") => {
  const el = document.createElement(tag);
  document.body.appendChild(el);
  return el;
};

// ---------------------------------------------------------------------------
// 72. Tabs and Accordion generate unique, valid document ids.
// ---------------------------------------------------------------------------
describe("widget ids are unique per binding", () => {
  function bindTabs(ids: string[]) {
    const t = tabs({ tabs: ids.map((id) => ({ id, label: id })) });
    const tablist = box();
    const tabEls = Object.fromEntries(ids.map((id) => [id, box("button")]));
    const panelEls = Object.fromEntries(ids.map((id) => [id, box()]));
    const teardown = t.bind({ tablist, tabs: tabEls, panels: panelEls });
    return { tabEls, panelEls, teardown };
  }

  function bindAccordion(ids: string[]) {
    const a = accordion({ items: ids.map((id) => ({ id, label: id })), multiple: true });
    const triggers = Object.fromEntries(ids.map((id) => [id, box("button")]));
    const panels = Object.fromEntries(ids.map((id) => [id, box()]));
    const teardown = a.bind({ root: box(), triggers, panels });
    return { triggers, panels, teardown };
  }

  const resolves = (el: Element, attr: string, expected: Element) => {
    const ref = el.getAttribute(attr) ?? "";
    expect(ref.split(/\s+/)).toHaveLength(1);
    expect(document.getElementById(ref)).toBe(expected);
  };

  it("two tab widgets with identical item ids never share element ids", () => {
    const first = bindTabs(["details"]);
    const second = bindTabs(["details"]);

    expect(first.tabEls.details.id).not.toBe(second.tabEls.details.id);
    expect(first.panelEls.details.id).not.toBe(second.panelEls.details.id);
    resolves(first.tabEls.details, "aria-controls", first.panelEls.details);
    resolves(second.tabEls.details, "aria-controls", second.panelEls.details);
    resolves(first.panelEls.details, "aria-labelledby", first.tabEls.details);
    resolves(second.panelEls.details, "aria-labelledby", second.tabEls.details);
  });

  it("two accordions with identical item ids never share element ids", () => {
    const first = bindAccordion(["faq"]);
    const second = bindAccordion(["faq"]);

    expect(first.triggers.faq.id).not.toBe(second.triggers.faq.id);
    resolves(first.triggers.faq, "aria-controls", first.panels.faq);
    resolves(second.triggers.faq, "aria-controls", second.panels.faq);
    resolves(first.panels.faq, "aria-labelledby", first.triggers.faq);
    resolves(second.panels.faq, "aria-labelledby", second.triggers.faq);
  });

  it("item ids with whitespace, punctuation and Unicode produce single-token references", () => {
    const ids = ["two words", "a#b.c", "ünïcode ✓", "tab\ttab"];
    const t = bindTabs(ids);
    const a = bindAccordion(ids);
    for (const id of ids) {
      expect(t.tabEls[id].id).not.toMatch(/\s/);
      resolves(t.tabEls[id], "aria-controls", t.panelEls[id]);
      resolves(a.triggers[id], "aria-controls", a.panels[id]);
    }
  });

  it("distinct item ids that sanitize alike still get distinct element ids", () => {
    const t = bindTabs(["a b", "a_b", "a-b"]);
    const ids = new Set(Object.values(t.tabEls).map((el) => el.id));
    expect(ids.size).toBe(3);
  });

  it("author-provided ids are preserved and still referenced", () => {
    const t = tabs({ tabs: [{ id: "x", label: "X" }] });
    const tablist = box();
    const tab = box("button");
    tab.id = "my-tab";
    const panel = box();
    panel.id = "my-panel";
    const teardown = t.bind({ tablist, tabs: { x: tab }, panels: { x: panel } });

    expect(tab.id).toBe("my-tab");
    expect(panel.id).toBe("my-panel");
    expect(tab.getAttribute("aria-controls")).toBe("my-panel");
    expect(panel.getAttribute("aria-labelledby")).toBe("my-tab");

    teardown();
    expect(tab.id).toBe("my-tab");
    expect(panel.id).toBe("my-panel");
  });

  it("teardown removes generated ids and rebinding produces valid references again", () => {
    const first = bindTabs(["one"]);
    first.teardown();
    expect(first.tabEls.one.hasAttribute("id")).toBe(false);

    const t = tabs({ tabs: [{ id: "one", label: "One" }] });
    const again = t.bind({ tablist: box(), tabs: first.tabEls, panels: first.panelEls });
    resolves(first.tabEls.one, "aria-controls", first.panelEls.one);
    again();
  });
});

// ---------------------------------------------------------------------------
// 74. datePicker teardown restores every cell it touched.
// ---------------------------------------------------------------------------
describe("datePicker cell restoration", () => {
  function setup(initial = new Date(2026, 0, 15)) {
    const dp = datePicker({ initialDate: initial });
    const grid = box();
    const cells = new Map<string, HTMLElement>();
    const cellFor = (date: Date) => {
      const key = date.toDateString();
      let cell = cells.get(key);
      if (!cell) {
        cell = box("button");
        cell.setAttribute("role", "button");
        cell.setAttribute("aria-label", key);
        cell.tabIndex = 5;
        cells.set(key, cell);
      }
      return cell;
    };
    return { dp, grid, cells, cellFor };
  }

  const snapshot = (el: HTMLElement) => ({
    role: el.getAttribute("role"),
    selected: el.getAttribute("aria-selected"),
    disabled: el.getAttribute("aria-disabled"),
    tabindex: el.getAttribute("tabindex"),
  });
  const ORIGINAL = { role: "button", selected: null, disabled: null, tabindex: "5" };

  it("teardown restores preexisting cell attributes", () => {
    const { dp, grid, cells, cellFor } = setup();
    const teardown = dp.bind({ grid, cell: cellFor });
    const any = [...cells.values()][0];
    expect(any.getAttribute("role")).toBe("gridcell");

    teardown();

    for (const cell of cells.values()) expect(snapshot(cell)).toEqual(ORIGINAL);
  });

  it("cells that leave the displayed month are restored while the binding stays active", () => {
    const { dp, grid, cells, cellFor } = setup();
    const teardown = dp.bind({ grid, cell: cellFor });
    const january = [...cells.entries()].filter(([k]) => k.includes("Jan")).map(([, c]) => c);

    dp.nextMonth();
    dp.nextMonth();

    for (const cell of january) expect(snapshot(cell)).toEqual(ORIGINAL);
    teardown();
    for (const cell of cells.values()) expect(snapshot(cell)).toEqual(ORIGINAL);
  });

  it("restores cells without preexisting attributes by removing what was added", () => {
    const dp = datePicker({ initialDate: new Date(2026, 5, 1) });
    const grid = box();
    const plain: HTMLElement[] = [];
    const teardown = dp.bind({
      grid,
      cell: () => {
        const el = box("span");
        plain.push(el);
        return el;
      },
    });
    teardown();
    for (const el of plain) {
      expect(el.hasAttribute("role")).toBe(false);
      expect(el.hasAttribute("aria-selected")).toBe(false);
      expect(el.hasAttribute("aria-disabled")).toBe(false);
      expect(el.hasAttribute("tabindex")).toBe(false);
    }
  });

  it("repeated bind/dispose leaves cells in their original state", () => {
    const { dp, grid, cells, cellFor } = setup();
    for (let i = 0; i < 3; i++) dp.bind({ grid, cell: cellFor })();
    for (const cell of cells.values()) expect(snapshot(cell)).toEqual(ORIGINAL);
  });
});

// ---------------------------------------------------------------------------
// 75. draggable() restores the elements it relinquishes.
// ---------------------------------------------------------------------------
describe("draggable restoration", () => {
  it("retargeting restores the previous element's draggable state", () => {
    const first = box();
    const second = box();
    first.setAttribute("draggable", "false");
    const [target, setTarget] = signal<HTMLElement | null>(first);
    const drag = draggable(target);
    expect(first.draggable).toBe(true);

    setTarget(second);

    expect(first.getAttribute("draggable")).toBe("false");
    expect(second.draggable).toBe(true);
    drag.dispose();
    expect(second.hasAttribute("draggable")).toBe(false);
  });

  it("disposal during a drag restores the element and clears isDragging", () => {
    const el = box();
    const drag = draggable(() => el);
    el.dispatchEvent(new Event("dragstart"));
    expect(drag.isDragging()).toBe(true);

    drag.dispose();
    drag.dispose();

    expect(drag.isDragging()).toBe(false);
    expect(el.hasAttribute("draggable")).toBe(false);
  });

  it("retargeting to null clears isDragging and restores the element", () => {
    const el = box();
    el.setAttribute("draggable", "true");
    const [target, setTarget] = signal<HTMLElement | null>(el);
    const drag = draggable(target);
    el.dispatchEvent(new Event("dragstart"));

    setTarget(null);

    expect(drag.isDragging()).toBe(false);
    expect(el.getAttribute("draggable")).toBe("true");
    drag.dispose();
  });
});

// ---------------------------------------------------------------------------
// 76. dropZone() stays "over" while moving between children.
// ---------------------------------------------------------------------------
describe("dropZone over state", () => {
  function makeZone() {
    const zone = box();
    const left = document.createElement("div");
    const right = document.createElement("div");
    const nested = document.createElement("span");
    right.appendChild(nested);
    zone.append(left, right);
    return { zone, left, right, nested };
  }
  const fire = (el: Element, type: string, relatedTarget: EventTarget | null = null) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "relatedTarget", { value: relatedTarget });
    el.dispatchEvent(e);
  };

  it("moving from one child to another keeps isOver true", () => {
    const { zone, left, right } = makeZone();
    const dz = dropZone(() => zone, { onDrop: () => {} });
    fire(left, "dragenter");
    expect(dz.isOver()).toBe(true);

    // Browser order: enter the new element, then leave the old one.
    fire(right, "dragenter", left);
    fire(left, "dragleave", right);

    expect(dz.isOver()).toBe(true);
    dz.dispose();
  });

  it("nested descendants keep isOver true until the zone is really left", () => {
    const { zone, right, nested } = makeZone();
    const dz = dropZone(() => zone, { onDrop: () => {} });
    fire(zone, "dragenter");
    fire(right, "dragenter", zone);
    fire(zone, "dragleave", right);
    fire(nested, "dragenter", right);
    fire(right, "dragleave", nested);
    expect(dz.isOver()).toBe(true);

    fire(nested, "dragleave", document.body);
    expect(dz.isOver()).toBe(false);
    dz.dispose();
  });

  it("a genuine exit and repeated enter/leave cycles stay balanced", () => {
    const { zone } = makeZone();
    const dz = dropZone(() => zone, { onDrop: () => {} });
    for (let i = 0; i < 3; i++) {
      fire(zone, "dragenter", document.body);
      expect(dz.isOver()).toBe(true);
      fire(zone, "dragleave", document.body);
      expect(dz.isOver()).toBe(false);
    }
    dz.dispose();
  });

  it("drop resets the over state and the counter", () => {
    const { zone, left } = makeZone();
    const onDrop = vi.fn();
    const dz = dropZone(() => zone, { onDrop });
    fire(zone, "dragenter");
    fire(left, "dragenter", zone);
    fire(left, "drop");
    expect(dz.isOver()).toBe(false);
    expect(onDrop).toHaveBeenCalledTimes(1);

    fire(zone, "dragenter", document.body);
    fire(zone, "dragleave", document.body);
    expect(dz.isOver()).toBe(false);
    dz.dispose();
  });

  it("retargeting resets the over state", () => {
    const a = makeZone();
    const b = makeZone();
    const [target, setTarget] = signal<HTMLElement | null>(a.zone);
    const dz = dropZone(target, { onDrop: () => {} });
    fire(a.zone, "dragenter");
    expect(dz.isOver()).toBe(true);

    setTarget(b.zone);

    expect(dz.isOver()).toBe(false);
    fire(b.zone, "dragenter", document.body);
    fire(b.zone, "dragleave", document.body);
    expect(dz.isOver()).toBe(false);
    dz.dispose();
  });
});

// ---------------------------------------------------------------------------
// 77. pointerLock().request() surfaces the browser's result.
// ---------------------------------------------------------------------------
describe("pointerLock request promise", () => {
  it("resolves when the browser's promise resolves", async () => {
    const el = { requestPointerLock: vi.fn(() => Promise.resolve()) } as unknown as Element;
    await expect(pointerLock().request(el)).resolves.toBeUndefined();
  });

  it("rejects with the browser's original failure", async () => {
    const failure = new DOMException("User activation required", "NotAllowedError");
    const el = { requestPointerLock: () => Promise.reject(failure) } as unknown as Element;
    await expect(pointerLock().request(el)).rejects.toBe(failure);
  });

  it("turns a synchronous throw into a rejection", async () => {
    const failure = new Error("sync failure");
    const el = {
      requestPointerLock: () => {
        throw failure;
      },
    } as unknown as Element;
    const result = pointerLock().request(el);
    await expect(result).rejects.toBe(failure);
  });

  it("normalizes a legacy void-returning implementation", async () => {
    const el = { requestPointerLock: vi.fn(() => undefined) } as unknown as Element;
    await expect(pointerLock().request(el)).resolves.toBeUndefined();
    expect(el.requestPointerLock).toHaveBeenCalled();
  });

  it("resolves without doing anything when the element does not support pointer lock", async () => {
    // A fire-and-forget `onclick: () => lock.request(el)` must not raise an
    // unhandled rejection on browsers without Pointer Lock (e.g. iOS Safari).
    const lock = pointerLock();
    await expect(lock.request({} as Element)).resolves.toBeUndefined();
    expect(lock.locked()).toBe(false);
  });
});
