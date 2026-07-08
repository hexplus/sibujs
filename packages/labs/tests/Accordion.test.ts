import { describe, expect, it } from "vitest";
import { accordion } from "../src/widgets/Accordion";

describe("accordion", () => {
  const itemDefs = [
    { id: "a", label: "Section A" },
    { id: "b", label: "Section B" },
    { id: "c", label: "Section C" },
  ];

  it("starts with defaultExpanded items expanded", () => {
    const acc = accordion({ items: itemDefs, defaultExpanded: ["b"] });
    const result = acc.items();
    expect(result[0].isExpanded).toBe(false);
    expect(result[1].isExpanded).toBe(true);
    expect(result[2].isExpanded).toBe(false);
  });

  it("toggles expansion in single mode (only one at a time)", () => {
    const acc = accordion({ items: itemDefs, multiple: false });
    acc.toggle("a");
    expect(acc.items()[0].isExpanded).toBe(true);
    expect(acc.items()[1].isExpanded).toBe(false);

    // Expanding another should collapse the first
    acc.toggle("b");
    expect(acc.items()[0].isExpanded).toBe(false);
    expect(acc.items()[1].isExpanded).toBe(true);

    // Toggling same one should collapse it
    acc.toggle("b");
    expect(acc.items()[1].isExpanded).toBe(false);
  });

  it("allows multiple expanded items in multiple mode", () => {
    const acc = accordion({ items: itemDefs, multiple: true });
    acc.expand("a");
    acc.expand("b");
    expect(acc.items()[0].isExpanded).toBe(true);
    expect(acc.items()[1].isExpanded).toBe(true);
    expect(acc.items()[2].isExpanded).toBe(false);
  });

  it("expandAll expands all items in multiple mode", () => {
    const acc = accordion({ items: itemDefs, multiple: true });
    acc.expandAll();
    expect(acc.items().every((i) => i.isExpanded)).toBe(true);
  });

  it("collapseAll collapses all items", () => {
    const acc = accordion({
      items: itemDefs,
      multiple: true,
      defaultExpanded: ["a", "b", "c"],
    });
    acc.collapseAll();
    expect(acc.items().every((i) => !i.isExpanded)).toBe(true);
  });

  it("expand and collapse work individually", () => {
    const acc = accordion({ items: itemDefs, multiple: true });
    acc.expand("c");
    expect(acc.items()[2].isExpanded).toBe(true);

    acc.collapse("c");
    expect(acc.items()[2].isExpanded).toBe(false);
  });
});
