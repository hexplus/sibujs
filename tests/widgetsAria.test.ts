import { describe, expect, it } from "vitest";
import { accordion } from "../src/widgets/Accordion";
import { popover } from "../src/widgets/Popover";
import { tabs } from "../src/widgets/Tabs";
import { tooltip } from "../src/widgets/Tooltip";

describe("Tabs.bind() — APG", () => {
  it("wires roles, aria-selected, roving tabindex, and Arrow keys", () => {
    const t = tabs({
      tabs: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      defaultTab: "a",
    });
    const tablist = document.createElement("div");
    const tabA = document.createElement("button");
    const tabB = document.createElement("button");
    tablist.append(tabA, tabB);
    document.body.appendChild(tablist);

    const dispose = t.bind({ tablist, tabs: { a: tabA, b: tabB } });
    expect(tablist.getAttribute("role")).toBe("tablist");
    expect(tabA.getAttribute("aria-selected")).toBe("true");
    expect(tabB.getAttribute("aria-selected")).toBe("false");
    expect(tabA.tabIndex).toBe(0);
    expect(tabB.tabIndex).toBe(-1);

    tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(t.activeTab()).toBe("b");
    expect(tabB.getAttribute("aria-selected")).toBe("true");

    dispose();
    document.body.removeChild(tablist);
  });

  it("bind() is idempotent", () => {
    const t = tabs({ tabs: [{ id: "a", label: "A" }] });
    const tablist = document.createElement("div");
    const tabA = document.createElement("button");
    tablist.append(tabA);
    const d1 = t.bind({ tablist, tabs: { a: tabA } });
    const d2 = t.bind({ tablist, tabs: { a: tabA } });
    expect(d1).toBe(d2);
    d1();
  });
});

describe("Accordion.bind()", () => {
  it("toggles aria-expanded via Enter/Space keyboard", () => {
    const a = accordion({
      items: [
        { id: "x", label: "X" },
        { id: "y", label: "Y" },
      ],
    });
    const trigX = document.createElement("button");
    const trigY = document.createElement("button");
    const panX = document.createElement("div");
    const panY = document.createElement("div");
    document.body.append(trigX, trigY, panX, panY);

    const dispose = a.bind({
      triggers: { x: trigX, y: trigY },
      panels: { x: panX, y: panY },
    });
    expect(trigX.getAttribute("aria-expanded")).toBe("false");

    trigX.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(trigX.getAttribute("aria-expanded")).toBe("true");
    expect(panX.hidden).toBe(false);

    dispose();
    document.body.removeChild(trigX);
    document.body.removeChild(trigY);
    document.body.removeChild(panX);
    document.body.removeChild(panY);
  });
});

describe("Tooltip.bind()", () => {
  it("hooks aria-describedby and Escape dismisses", () => {
    const tip = tooltip({ delay: 0, hideDelay: 10 });
    const trig = document.createElement("button");
    const tipEl = document.createElement("div");
    document.body.append(trig, tipEl);

    const dispose = tip.bind({ trigger: trig, tooltip: tipEl });
    expect(trig.getAttribute("aria-describedby")).toBeTruthy();
    expect(tipEl.getAttribute("role")).toBe("tooltip");

    trig.dispatchEvent(new Event("focus"));
    expect(tip.isVisible()).toBe(true);
    trig.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(tip.isVisible()).toBe(false);

    dispose();
    expect(trig.hasAttribute("aria-describedby")).toBe(false);
    document.body.removeChild(trig);
    document.body.removeChild(tipEl);
  });
});

describe("Popover.bind()", () => {
  it("wires role=dialog, aria-expanded, and Escape", () => {
    const p = popover();
    const trig = document.createElement("button");
    const pop = document.createElement("div");
    document.body.append(trig, pop);

    const dispose = p.bind({ trigger: trig, popover: pop });
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(trig.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trig.getAttribute("aria-expanded")).toBe("false");

    trig.dispatchEvent(new MouseEvent("click"));
    expect(p.isOpen()).toBe(true);
    expect(trig.getAttribute("aria-expanded")).toBe("true");

    pop.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(p.isOpen()).toBe(false);

    dispose();
    document.body.removeChild(trig);
    document.body.removeChild(pop);
  });
});
