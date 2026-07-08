import { describe, expect, it } from "vitest";
import { tabs } from "../src/widgets/Tabs";

describe("tabs", () => {
  const tabDefs = [
    { id: "tab1", label: "Tab 1" },
    { id: "tab2", label: "Tab 2" },
    { id: "tab3", label: "Tab 3", disabled: true },
    { id: "tab4", label: "Tab 4" },
  ];

  it("defaults to the first non-disabled tab", () => {
    const t = tabs({ tabs: tabDefs });
    expect(t.activeTab()).toBe("tab1");
  });

  it("uses defaultTab when provided", () => {
    const t = tabs({ tabs: tabDefs, defaultTab: "tab2" });
    expect(t.activeTab()).toBe("tab2");
  });

  it("sets active tab and enriches tabs with isActive", () => {
    const t = tabs({ tabs: tabDefs });
    t.setActiveTab("tab2");
    expect(t.activeTab()).toBe("tab2");

    const enriched = t.tabs();
    expect(enriched[0].isActive).toBe(false);
    expect(enriched[1].isActive).toBe(true);
  });

  it("does not allow setting a disabled tab as active", () => {
    const t = tabs({ tabs: tabDefs });
    t.setActiveTab("tab3");
    expect(t.activeTab()).toBe("tab1"); // unchanged
  });

  it("navigates to next tab, skipping disabled ones", () => {
    const t = tabs({ tabs: tabDefs });
    t.setActiveTab("tab2");
    t.nextTab(); // should skip tab3 (disabled) and go to tab4
    expect(t.activeTab()).toBe("tab4");
  });

  it("navigates to previous tab, skipping disabled and wrapping", () => {
    const t = tabs({ tabs: tabDefs });
    t.setActiveTab("tab4");
    t.prevTab(); // should skip tab3 (disabled) and go to tab2
    expect(t.activeTab()).toBe("tab2");

    // Wrap from tab1 backward
    t.setActiveTab("tab1");
    t.prevTab(); // wraps to tab4
    expect(t.activeTab()).toBe("tab4");
  });
});
