import { afterEach, describe, expect, it } from "vitest";
import { tabs } from "../src/widgets/Tabs";

const DEFS = [
  { id: "one", label: "One" },
  { id: "two", label: "Two" },
  { id: "three", label: "Three" },
];

function setup(t: ReturnType<typeof tabs>, defs = DEFS, withPanels = true) {
  const tablist = document.createElement("div");
  const tabEls: Record<string, HTMLElement> = {};
  const panelEls: Record<string, HTMLElement> = {};
  for (const def of defs) {
    const tabEl = document.createElement("button");
    tabEls[def.id] = tabEl;
    tablist.appendChild(tabEl);
    if (withPanels) {
      const panel = document.createElement("div");
      panelEls[def.id] = panel;
      document.body.appendChild(panel);
    }
  }
  document.body.appendChild(tablist);
  const dispose = t.bind({
    tablist,
    tabs: tabEls,
    panels: withPanels ? panelEls : undefined,
  });
  return { tablist, tabEls, panelEls, dispose };
}

describe("tabs coverage", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("defaults to first non-disabled tab", () => {
    const t = tabs({
      tabs: [
        { id: "a", label: "A", disabled: true },
        { id: "b", label: "B" },
      ],
    });
    expect(t.activeTab()).toBe("b");
  });

  it("honors explicit defaultTab", () => {
    const t = tabs({ tabs: DEFS, defaultTab: "two" });
    expect(t.activeTab()).toBe("two");
  });

  it("empty tab list yields empty active", () => {
    const t = tabs({ tabs: [] });
    expect(t.activeTab()).toBe("");
    t.nextTab();
    t.prevTab();
    expect(t.activeTab()).toBe("");
  });

  it("setActiveTab ignores unknown and disabled tabs", () => {
    const t = tabs({
      tabs: [
        { id: "a", label: "A" },
        { id: "b", label: "B", disabled: true },
      ],
    });
    t.setActiveTab("missing");
    expect(t.activeTab()).toBe("a");
    t.setActiveTab("b");
    expect(t.activeTab()).toBe("a");
    t.setActiveTab("a");
    expect(t.activeTab()).toBe("a");
  });

  it("tabs() derived reflects isActive", () => {
    const t = tabs({ tabs: DEFS });
    const list = t.tabs();
    expect(list[0].isActive).toBe(true);
    expect(list[1].isActive).toBe(false);
    t.setActiveTab("two");
    expect(t.tabs()[1].isActive).toBe(true);
  });

  it("nextTab/prevTab wrap and skip disabled", () => {
    const t = tabs({
      tabs: [
        { id: "a", label: "A" },
        { id: "b", label: "B", disabled: true },
        { id: "c", label: "C" },
      ],
    });
    t.nextTab(); // a -> skip b -> c
    expect(t.activeTab()).toBe("c");
    t.nextTab(); // c -> wrap -> a
    expect(t.activeTab()).toBe("a");
    t.prevTab(); // a -> wrap -> skip b -> c
    expect(t.activeTab()).toBe("c");
  });

  it("isActive getter", () => {
    const t = tabs({ tabs: DEFS });
    expect(t.isActive("one")).toBe(true);
    expect(t.isActive("two")).toBe(false);
  });

  it("bind wires tablist and tab/panel ARIA", () => {
    const t = tabs({ tabs: DEFS });
    const { tablist, tabEls, panelEls } = setup(t);
    expect(tablist.getAttribute("role")).toBe("tablist");
    expect(tabEls.one.getAttribute("role")).toBe("tab");
    expect(tabEls.one.id).toBe("sibu-tab-one");
    expect(tabEls.one.getAttribute("aria-controls")).toBe("sibu-tabpanel-one");
    expect(tabEls.one.getAttribute("aria-selected")).toBe("true");
    expect(tabEls.one.tabIndex).toBe(0);
    expect(tabEls.two.tabIndex).toBe(-1);
    expect(panelEls.one.getAttribute("role")).toBe("tabpanel");
    expect(panelEls.one.id).toBe("sibu-tabpanel-one");
    expect(panelEls.one.getAttribute("aria-labelledby")).toBe("sibu-tab-one");
    expect(panelEls.one.hidden).toBe(false);
    expect(panelEls.two.hidden).toBe(true);
  });

  it("bind sets aria-disabled on disabled tabs and skips missing tab elements", () => {
    const t = tabs({
      tabs: [
        { id: "a", label: "A" },
        { id: "b", label: "B", disabled: true },
      ],
    });
    const tablist = document.createElement("div");
    const tabEl = document.createElement("button");
    // Only provide element for "b"; "a" is missing -> continue branch.
    t.bind({ tablist, tabs: { b: tabEl } });
    expect(tabEl.getAttribute("aria-disabled")).toBe("true");
  });

  it("bind works without panels", () => {
    const t = tabs({ tabs: DEFS });
    const { tabEls } = setup(t, DEFS, false);
    expect(tabEls.one.getAttribute("aria-controls")).toBeNull();
    expect(tabEls.one.getAttribute("aria-selected")).toBe("true");
  });

  it("click activates a tab", () => {
    const t = tabs({ tabs: DEFS });
    const { tabEls } = setup(t);
    tabEls.two.dispatchEvent(new MouseEvent("click"));
    expect(t.activeTab()).toBe("two");
  });

  it("ArrowRight/ArrowDown move to next tab and focus", () => {
    const t = tabs({ tabs: DEFS });
    const { tablist, tabEls } = setup(t);
    tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(t.activeTab()).toBe("two");
    expect(document.activeElement).toBe(tabEls.two);
    tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(t.activeTab()).toBe("three");
  });

  it("ArrowLeft/ArrowUp move to previous tab", () => {
    const t = tabs({ tabs: DEFS, defaultTab: "two" });
    const { tablist } = setup(t);
    tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(t.activeTab()).toBe("one");
    tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(t.activeTab()).toBe("three");
  });

  it("Home and End jump to first/last enabled tab", () => {
    const t = tabs({
      tabs: [
        { id: "a", label: "A", disabled: true },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
        { id: "d", label: "D", disabled: true },
      ],
      defaultTab: "c",
    });
    const { tablist, tabEls } = setup(t);
    tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(t.activeTab()).toBe("b"); // first enabled
    void tabEls;
    tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(t.activeTab()).toBe("c"); // last enabled
  });

  it("unhandled key is ignored", () => {
    const t = tabs({ tabs: DEFS });
    const { tablist } = setup(t);
    tablist.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    expect(t.activeTab()).toBe("one");
  });

  it("teardown restores attributes and removes listeners", () => {
    const t = tabs({ tabs: DEFS });
    const tablist = document.createElement("div");
    tablist.setAttribute("role", "navigation"); // pre-existing role
    const tabEls: Record<string, HTMLElement> = {};
    const panelEls: Record<string, HTMLElement> = {};
    for (const def of DEFS) {
      const el = document.createElement("button");
      tabEls[def.id] = el;
      const panel = document.createElement("div");
      panelEls[def.id] = panel;
    }
    const dispose = t.bind({ tablist, tabs: tabEls, panels: panelEls });
    expect(tablist.getAttribute("role")).toBe("tablist");
    dispose();
    // restored prior role
    expect(tablist.getAttribute("role")).toBe("navigation");
    expect(tabEls.one.getAttribute("role")).toBeNull();
    expect(tabEls.one.getAttribute("aria-selected")).toBeNull();
    expect(tabEls.one.hasAttribute("tabindex")).toBe(false);
    expect(panelEls.one.getAttribute("role")).toBeNull();
    // click listener removed
    tabEls.two.dispatchEvent(new MouseEvent("click"));
    expect(t.activeTab()).toBe("one");
  });

  it("bind twice returns same teardown", () => {
    const t = tabs({ tabs: DEFS });
    const { tablist, tabEls, panelEls, dispose } = setup(t);
    const again = t.bind({ tablist, tabs: tabEls, panels: panelEls });
    expect(again).toBe(dispose);
    dispose();
  });

  it("teardown restores pre-existing tab attributes", () => {
    const t = tabs({ tabs: [{ id: "a", label: "A" }] });
    const tablist = document.createElement("div");
    const tabEl = document.createElement("button");
    tabEl.id = "preid";
    tabEl.setAttribute("role", "presentation");
    tabEl.setAttribute("aria-controls", "precontrols");
    const panel = document.createElement("div");
    panel.id = "prepanel";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-labelledby", "prelabel");
    const dispose = t.bind({ tablist, tabs: { a: tabEl }, panels: { a: panel } });
    dispose();
    expect(tabEl.id).toBe("preid");
    expect(tabEl.getAttribute("role")).toBe("presentation");
    expect(tabEl.getAttribute("aria-controls")).toBe("precontrols");
    expect(panel.id).toBe("prepanel");
    expect(panel.getAttribute("role")).toBe("region");
    expect(panel.getAttribute("aria-labelledby")).toBe("prelabel");
  });
});
