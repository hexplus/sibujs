import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { popover } from "../src/widgets/Popover";

const makeEls = (withLabel = false) => {
  const trigger = document.createElement("button");
  const pop = document.createElement("div");
  document.body.appendChild(trigger);
  document.body.appendChild(pop);
  const els: { trigger: HTMLElement; popover: HTMLElement; labelledBy?: HTMLElement } = {
    trigger,
    popover: pop,
  };
  if (withLabel) {
    const label = document.createElement("h2");
    label.textContent = "Title";
    document.body.appendChild(label);
    els.labelledBy = label;
  }
  return els;
};

describe("popover bind coverage", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("wires dialog role, ids, and aria attributes on bind", () => {
    const pop = popover();
    const els = makeEls();
    const teardown = pop.bind(els);
    expect(els.popover.getAttribute("role")).toBe("dialog");
    expect(els.popover.id).toMatch(/^sibu-popover-\d+$/);
    expect(els.trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(els.trigger.getAttribute("aria-controls")).toBe(els.popover.id);
    // Initially closed.
    expect(els.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(els.popover.hidden).toBe(true);
    teardown();
  });

  it("assigns a label id and wires aria-labelledby", () => {
    const pop = popover();
    const els = makeEls(true);
    const teardown = pop.bind(els);
    const labelId = els.labelledBy?.id ?? "";
    expect(labelId).toMatch(/-label$/);
    expect(els.popover.getAttribute("aria-labelledby")).toBe(labelId);
    teardown();
    // Auto-assigned label id is removed on teardown.
    expect(els.labelledBy?.hasAttribute("id")).toBe(false);
  });

  it("keeps an existing label id rather than overwriting it", () => {
    const pop = popover();
    const els = makeEls(true);
    if (els.labelledBy) els.labelledBy.id = "preset-label";
    const teardown = pop.bind(els);
    expect(els.popover.getAttribute("aria-labelledby")).toBe("preset-label");
    teardown();
    // Pre-existing id is preserved on teardown.
    expect(els.labelledBy?.id).toBe("preset-label");
  });

  it("toggles open via trigger click and updates aria-expanded", () => {
    const pop = popover();
    const els = makeEls();
    pop.bind(els);
    els.trigger.dispatchEvent(new MouseEvent("click"));
    expect(pop.isOpen()).toBe(true);
    expect(els.trigger.getAttribute("aria-expanded")).toBe("true");
    expect(els.popover.hidden).toBe(false);
    els.trigger.dispatchEvent(new MouseEvent("click"));
    expect(pop.isOpen()).toBe(false);
  });

  it("closes and refocuses trigger on Escape when open", () => {
    const pop = popover();
    const els = makeEls();
    pop.bind(els);
    const focusSpy = vi.spyOn(els.trigger, "focus");
    pop.open();
    els.popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(pop.isOpen()).toBe(false);
    expect(focusSpy).toHaveBeenCalled();
  });

  it("ignores Escape when closed", () => {
    const pop = popover();
    const els = makeEls();
    pop.bind(els);
    els.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(pop.isOpen()).toBe(false);
  });

  it("closes on outside pointerdown but not on inside clicks", () => {
    const pop = popover();
    const els = makeEls();
    pop.bind(els);
    pop.open();

    // Pointer inside the popover keeps it open.
    els.popover.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    // jsdom PointerEvent target handling: dispatch a real PointerEvent on document.
    const insideEvt = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(insideEvt, "target", { value: els.popover });
    document.dispatchEvent(insideEvt);
    expect(pop.isOpen()).toBe(true);

    // Pointer on the trigger keeps it open.
    const triggerEvt = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(triggerEvt, "target", { value: els.trigger });
    document.dispatchEvent(triggerEvt);
    expect(pop.isOpen()).toBe(true);

    // Pointer outside closes it.
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const outsideEvt = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(outsideEvt, "target", { value: outside });
    document.dispatchEvent(outsideEvt);
    expect(pop.isOpen()).toBe(false);
  });

  it("outside pointer does nothing when popover is closed", () => {
    const pop = popover();
    const els = makeEls();
    pop.bind(els);
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const evt = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(evt, "target", { value: outside });
    document.dispatchEvent(evt);
    expect(pop.isOpen()).toBe(false);
  });

  it("is idempotent: a second bind returns the same teardown", () => {
    const pop = popover();
    const els = makeEls();
    const t1 = pop.bind(els);
    const t2 = pop.bind(els);
    expect(t1).toBe(t2);
    t1();
  });

  it("teardown restores prior attribute state and removes listeners", () => {
    const pop = popover();
    const els = makeEls();
    els.popover.setAttribute("role", "region");
    els.popover.id = "preset-pop";
    els.popover.setAttribute("aria-labelledby", "preset-lbl");
    els.trigger.setAttribute("aria-haspopup", "menu");
    els.trigger.setAttribute("aria-controls", "preset-ctrl");

    const teardown = pop.bind(els);
    teardown();

    expect(els.popover.getAttribute("role")).toBe("region");
    expect(els.popover.id).toBe("preset-pop");
    expect(els.popover.getAttribute("aria-labelledby")).toBe("preset-lbl");
    expect(els.trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(els.trigger.getAttribute("aria-controls")).toBe("preset-ctrl");
    expect(els.trigger.hasAttribute("aria-expanded")).toBe(false);

    // Listeners removed: outside pointer no longer affects state.
    pop.open();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const evt = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(evt, "target", { value: outside });
    document.dispatchEvent(evt);
    expect(pop.isOpen()).toBe(true);
  });

  it("teardown removes attributes that had no prior value", () => {
    const pop = popover();
    const els = makeEls();
    const teardown = pop.bind(els);
    teardown();
    expect(els.popover.hasAttribute("role")).toBe(false);
    expect(els.popover.hasAttribute("id")).toBe(false);
    expect(els.trigger.hasAttribute("aria-haspopup")).toBe(false);
    expect(els.trigger.hasAttribute("aria-controls")).toBe(false);
  });
});
