import { describe, expect, it } from "vitest";
import { type HydrationMismatch, hydrate } from "../src/platform/ssr";

describe("hydrate diagnostics", () => {
  it("does not call onMismatch when trees match", () => {
    const container = document.createElement("div");
    container.innerHTML = '<span class="a">hello</span>';

    let called = false;
    hydrate(
      () => {
        const el = document.createElement("span");
        el.className = "a";
        el.textContent = "hello";
        return el;
      },
      container,
      {
        diagnostics: true,
        onMismatch: () => {
          called = true;
        },
      },
    );

    expect(called).toBe(false);
  });

  it("reports a tag mismatch", () => {
    const container = document.createElement("div");
    container.innerHTML = "<span>x</span>";

    const mismatches: HydrationMismatch[] = [];
    hydrate(
      () => {
        const el = document.createElement("p");
        el.textContent = "x";
        return el;
      },
      container,
      { diagnostics: true, onMismatch: (m) => mismatches.push(m) },
    );

    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches[0].kind).toBe("tag");
    expect(mismatches[0].serverValue).toBe("span");
    expect(mismatches[0].clientValue).toBe("p");
  });

  it("reports an attribute diff", () => {
    const container = document.createElement("div");
    container.innerHTML = '<a href="/x">link</a>';

    const mismatches: HydrationMismatch[] = [];
    hydrate(
      () => {
        const el = document.createElement("a");
        el.setAttribute("href", "/y");
        el.textContent = "link";
        return el;
      },
      container,
      { diagnostics: true, onMismatch: (m) => mismatches.push(m) },
    );

    expect(mismatches[0].kind).toBe("attribute");
  });

  it("ignores sibujs-internal attribute markers", () => {
    const container = document.createElement("div");
    container.innerHTML = '<span data-sibu-ssr="true">hi</span>';

    const mismatches: HydrationMismatch[] = [];
    hydrate(
      () => {
        const el = document.createElement("span");
        el.textContent = "hi";
        return el;
      },
      container,
      { diagnostics: true, onMismatch: (m) => mismatches.push(m) },
    );

    expect(mismatches.length).toBe(0);
  });
});
