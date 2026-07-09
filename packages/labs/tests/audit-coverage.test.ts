import { dispose, Loading } from "@sibujs/core";
import { stream } from "sibujs/data";
import { Head } from "sibujs/ssr";
import { hover } from "sibujs/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persisted } from "../src/patterns/persist";
import { combobox } from "../src/widgets/Combobox";
import { datePicker } from "../src/widgets/datePicker";
import { select as selectWidget } from "../src/widgets/Select";

// Regression coverage for the audit's accessibility (E), SSR-guard (C), and
// leak/disposer (B) themes — the mechanical fixes that lacked dedicated tests.

// ── E3 — Loading is announced to assistive tech ─────────────────────────────
describe("Loading — screen-reader semantics (E3)", () => {
  it("exposes role=status / aria-live and a default label, deferring to text when present", () => {
    const bare = Loading();
    expect(bare.getAttribute("role")).toBe("status");
    expect(bare.getAttribute("aria-live")).toBe("polite");
    expect(bare.getAttribute("aria-label")).toBe("Loading"); // no visible text → labeled

    const labelled = Loading({ text: "Saving…" });
    expect(labelled.getAttribute("role")).toBe("status");
    expect(labelled.getAttribute("aria-label")).toBeNull(); // visible text is the name
  });
});

// ── E5 — widget bind() is reversible ────────────────────────────────────────
describe("Select.bind() — reversible ARIA wiring (E5)", () => {
  it("restores the listbox's attributes on teardown", () => {
    const listbox = document.createElement("ul");
    const sel = selectWidget<string>({ items: ["a", "b"] });

    const teardown = sel.bind({ listbox, option: () => null });
    expect(listbox.getAttribute("role")).toBe("listbox");
    expect(listbox.id).not.toBe("");
    expect(listbox.getAttribute("aria-multiselectable")).toBe("false");

    teardown();
    expect(listbox.getAttribute("role")).toBeNull();
    expect(listbox.id).toBe("");
    expect(listbox.getAttribute("aria-multiselectable")).toBeNull();
    expect(listbox.getAttribute("tabindex")).toBeNull();
  });
});

// ── E6 — combobox option click doesn't race the blur-close ──────────────────
describe("combobox.bind() — pointer-down inside the listbox keeps input focus (E6)", () => {
  it("prevents default on listbox mousedown so the option click lands", () => {
    const input = document.createElement("input");
    const listbox = document.createElement("ul");
    const cb = combobox<string>({ items: ["apple", "banana"] });

    const teardown = cb.bind({ input, listbox, option: () => null });
    const ev = new MouseEvent("mousedown", { cancelable: true, bubbles: true });
    listbox.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    teardown();
  });
});

// ── E1 — datePicker grid has an accessible name (and E5 restore) ────────────
describe("datePicker.bind() — grid role + accessible name (E1)", () => {
  it("labels the grid with the displayed month and restores attributes on teardown", () => {
    const grid = document.createElement("div");
    const dp = datePicker({ initialDate: new Date(2026, 5, 15) });

    const teardown = dp.bind({ grid, cell: () => null });
    expect(grid.getAttribute("role")).toBe("grid");
    expect(grid.getAttribute("aria-label")).toMatch(/2026/); // month/year name

    teardown();
    expect(grid.getAttribute("role")).toBeNull();
    expect(grid.getAttribute("aria-label")).toBeNull();
  });
});

// ── C4 — stream degrades instead of throwing where EventSource is absent ────
describe("stream — SSR / unsupported-runtime guard (C4)", () => {
  it("stays 'closed' instead of throwing when EventSource is unavailable", () => {
    // jsdom provides no EventSource — connect() must not throw at construction.
    expect(typeof EventSource).toBe("undefined");
    const s = stream("https://example.com/sse");
    expect(s.status()).toBe("closed");
    s.dispose();
  });
});

// ── C1 — persist degrades to a plain signal when storage is unavailable ─────
describe("persisted — degrades gracefully when storage throws/absent (C1)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("still works as a signal when localStorage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    const [value, setValue] = persisted("audit-c1", "initial");
    expect(value()).toBe("initial");
    setValue("next"); // must not throw despite no storage
    expect(value()).toBe("next");
  });
});

// ── B2 — Head() ties its injected <head> elements to disposal ───────────────
describe("Head() — injected elements are released on dispose (B2)", () => {
  it("removes its managed meta element when the anchor is disposed", () => {
    const sel = 'meta[name="sibu-audit-b2"]';
    expect(document.head.querySelector(sel)).toBeNull();

    const anchor = Head({ title: "Audit B2", meta: [{ name: "sibu-audit-b2", content: "x" }] });
    expect(document.head.querySelector(sel)?.getAttribute("content")).toBe("x");

    dispose(anchor);
    // Without the disposer this element would leak in <head> forever.
    expect(document.head.querySelector(sel)).toBeNull();
  });
});

// ── B7 — hover() releases its listeners on element disposal ─────────────────
describe("hover() — listeners released with the element (B7)", () => {
  it("stops responding to pointer events once the element is disposed", () => {
    const el = document.createElement("div");
    const h = hover(el);

    el.dispatchEvent(new Event("pointerenter"));
    expect(h.hovered()).toBe(true);

    dispose(el); // registerDisposer(el, dispose) removes the listeners
    el.dispatchEvent(new Event("pointerleave"));
    // The leave listener is gone, so the state is no longer mutated.
    expect(h.hovered()).toBe(true);
  });
});
