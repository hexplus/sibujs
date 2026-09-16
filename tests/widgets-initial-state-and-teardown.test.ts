import { describe, expect, it } from "vitest";
import { accordion } from "../src/widgets/Accordion";
import { fileUpload } from "../src/widgets/FileUpload";
import { tabs } from "../src/widgets/Tabs";

// ---------------------------------------------------------------------------
// Widget initial state respects the widget's own invariants, and `bind()`
// teardown restores every DOM value it changed.
//
// THE DEFECTS:
// - accordion() seeded its state from `defaultExpanded` verbatim, so single mode
//   could start with several panels open, and unknown ids were kept.
// - tabs() accepted a disabled or nonexistent `defaultTab` as the active tab.
// - Tabs and Accordion toggled `panel.hidden`, and FileUpload overwrote
//   `input.accept`, `input.multiple`, the error region's text and
//   `data-drag-over`, without restoring any of them on teardown.
// ---------------------------------------------------------------------------

const box = (): HTMLElement => document.createElement("div");

describe("accordion initial state", () => {
  const items = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ];
  const expanded = (acc: ReturnType<typeof accordion>) =>
    acc
      .items()
      .filter((i) => i.isExpanded)
      .map((i) => i.id);

  it("single mode keeps only the first valid default", () => {
    const acc = accordion({ items, multiple: false, defaultExpanded: ["a", "b"] });
    expect(expanded(acc)).toEqual(["a"]);
    expect(acc.isExpanded("b")).toBe(false);
  });

  it("drops unknown ids before choosing the single-mode default", () => {
    const acc = accordion({ items, defaultExpanded: ["missing", "c"] });
    expect(expanded(acc)).toEqual(["c"]);
  });

  it("multiple mode keeps every known default and drops unknown ids", () => {
    const acc = accordion({ items, multiple: true, defaultExpanded: ["c", "missing", "a"] });
    expect(expanded(acc)).toEqual(["a", "c"]);
    expect(acc.isExpanded("missing")).toBe(false);
  });

  it("no valid defaults means nothing is expanded", () => {
    const acc = accordion({ items, defaultExpanded: ["missing"] });
    expect(expanded(acc)).toEqual([]);
  });
});

describe("tabs initial state", () => {
  it("a disabled defaultTab falls back to the first enabled tab", () => {
    const t = tabs({
      tabs: [
        { id: "a", label: "A", disabled: true },
        { id: "b", label: "B" },
      ],
      defaultTab: "a",
    });
    expect(t.activeTab()).toBe("b");
  });

  it("an unknown defaultTab falls back to the first enabled tab", () => {
    const t = tabs({
      tabs: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      defaultTab: "nope",
    });
    expect(t.activeTab()).toBe("a");
  });

  it("a valid enabled defaultTab is honored", () => {
    const t = tabs({
      tabs: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      defaultTab: "b",
    });
    expect(t.activeTab()).toBe("b");
  });

  it("when every tab is disabled, no tab is active", () => {
    const t = tabs({
      tabs: [
        { id: "a", label: "A", disabled: true },
        { id: "b", label: "B", disabled: true },
      ],
      defaultTab: "a",
    });
    expect(t.activeTab()).toBe("");
    expect(t.tabs().some((tab) => tab.isActive)).toBe(false);
  });
});

describe("bind() teardown restores DOM state", () => {
  it("Tabs restores each panel's original hidden state", () => {
    const t = tabs({
      tabs: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
    });
    const tablist = box();
    const tabEls = { a: box(), b: box(), c: box() };
    const panels = { a: box(), b: box(), c: box() };
    panels.a.hidden = true; // hidden before bind, becomes visible while active
    panels.b.hidden = false; // visible before bind, becomes hidden
    panels.c.hidden = true;

    const teardown = t.bind({ tablist, tabs: tabEls, panels });
    expect(panels.a.hidden).toBe(false);
    expect(panels.b.hidden).toBe(true);

    teardown();
    expect(panels.a.hidden).toBe(true);
    expect(panels.b.hidden).toBe(false);
    expect(panels.c.hidden).toBe(true);

    teardown();
    expect(panels.b.hidden).toBe(false);
  });

  it("Accordion restores each panel's original hidden state", () => {
    const acc = accordion({
      items: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      defaultExpanded: ["b"],
    });
    const root = box();
    const triggers = { a: box(), b: box() };
    const panels = { a: box(), b: box() };
    panels.a.hidden = false; // visible before bind, collapsed while bound
    panels.b.hidden = true; // hidden before bind, expanded while bound

    const teardown = acc.bind({ root, triggers, panels });
    expect(panels.a.hidden).toBe(true);
    expect(panels.b.hidden).toBe(false);

    teardown();
    expect(panels.a.hidden).toBe(false);
    expect(panels.b.hidden).toBe(true);

    teardown();
    expect(panels.a.hidden).toBe(false);
  });

  it("FileUpload restores accept, multiple, error text and data-drag-over", () => {
    const upload = fileUpload({ accept: "image/*", multiple: true, maxSize: 1 });
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt";
    input.multiple = false;
    const errorRegion = box();
    errorRegion.textContent = "Existing message";
    const dropZone = box();
    dropZone.setAttribute("data-drag-over", "custom");

    const teardown = upload.bind({ input, errorRegion, dropZone });
    expect(input.accept).toBe("image/*");
    expect(input.multiple).toBe(true);
    upload.addFiles([new File(["too big"], "big.png", { type: "image/png" })]);
    upload.setDragOver(true);
    expect(errorRegion.textContent).not.toBe("Existing message");
    expect(dropZone.getAttribute("data-drag-over")).toBe("true");

    teardown();
    expect(input.accept).toBe(".txt");
    expect(input.multiple).toBe(false);
    expect(errorRegion.textContent).toBe("Existing message");
    expect(dropZone.getAttribute("data-drag-over")).toBe("custom");

    teardown();
    expect(input.accept).toBe(".txt");
  });

  it("FileUpload removes attributes that did not exist before bind", () => {
    const upload = fileUpload({ accept: "image/*" });
    const input = document.createElement("input");
    input.type = "file";
    const dropZone = box();

    const teardown = upload.bind({ input, dropZone });
    expect(input.hasAttribute("accept")).toBe(true);
    expect(dropZone.hasAttribute("data-drag-over")).toBe(true);

    teardown();
    expect(input.hasAttribute("accept")).toBe(false);
    expect(input.hasAttribute("multiple")).toBe(false);
    expect(dropZone.hasAttribute("data-drag-over")).toBe(false);
  });
});
