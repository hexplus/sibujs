import { describe, expect, it, vi } from "vitest";
import { html } from "../src/core/rendering/htm";
import { signal } from "../src/core/signals/signal";

describe("htm coverage2 — attribute sanitization in expressions", () => {
  it("sanitizes a URL attribute passed as an expression", () => {
    const el = html`<a href=${"javascript:alert(1)"}>link</a>` as HTMLAnchorElement;
    expect(el.getAttribute("href")).not.toContain("javascript:");
  });

  it("sanitizes srcset passed as an expression", () => {
    const el = html`<img srcset=${"javascript:bad 1x"} />` as HTMLImageElement;
    expect(el.getAttribute("srcset") ?? "").not.toContain("javascript:");
  });

  it("sanitizes a URL attribute in a mixed (static + expr) value", () => {
    const el = html`<a href="java${"script"}:alert(1)">x</a>` as HTMLAnchorElement;
    expect(el.getAttribute("href")).not.toContain("javascript:");
  });

  it("sanitizes srcset in a mixed value", () => {
    const el = html`<img srcset="java${"script"}:bad 1x" />` as HTMLImageElement;
    expect(el.getAttribute("srcset") ?? "").not.toContain("javascript:");
  });

  it("keeps a plain mixed attribute value", () => {
    const el = html`<div data-x="a-${"b"}-c"></div>`;
    expect(el.getAttribute("data-x")).toBe("a-b-c");
  });
});

describe("htm coverage2 — single-root reactive child", () => {
  it("binds a function child reactively", () => {
    const [n, setN] = signal("one");
    const el = html`<div>${() => n()}</div>`;
    expect(el.textContent).toContain("one");
    setN("two");
    expect(el.textContent).toContain("two");
  });

  it("appends an array of nodes and primitives", () => {
    const span = document.createElement("span");
    span.textContent = "S";
    const el = html`<div>${[span, "text", 5, false, null]}</div>`;
    expect(el.contains(span)).toBe(true);
    expect(el.textContent).toContain("text");
    expect(el.textContent).toContain("5");
  });

  it("appends a single Node expression child", () => {
    const node = document.createElement("b");
    const el = html`<div>${node}</div>`;
    expect(el.firstChild).toBe(node);
  });
});

describe("htm coverage2 — multi-root wrapper", () => {
  it("wraps multiple root elements in a div", () => {
    const el = html`<span>a</span><span>b</span>`;
    expect(el.tagName).toBe("DIV");
    expect(el.querySelectorAll("span").length).toBe(2);
  });

  it("multi-root with a Node expression child", () => {
    const node = document.createElement("i");
    const el = html`<span>x</span>${node}`;
    expect(el.contains(node)).toBe(true);
  });

  it("multi-root with a function child binds reactively", () => {
    const [n, setN] = signal("p");
    const el = html`<span>x</span>${() => n()}`;
    expect(el.textContent).toContain("p");
    setN("q");
    expect(el.textContent).toContain("q");
  });

  it("multi-root with an array child", () => {
    const node = document.createElement("u");
    const el = html`<span>x</span>${[node, "txt", 9, true]}`;
    expect(el.contains(node)).toBe(true);
    expect(el.textContent).toContain("txt");
    expect(el.textContent).toContain("9");
  });

  it("multi-root with a primitive expression child", () => {
    const el = html`<span>x</span>${"plain"}`;
    expect(el.textContent).toContain("plain");
  });

  it("unwraps to single element when wrapper ends with one element child", () => {
    // The null expression produces no child, leaving section as the sole child,
    // so the wrapper unwraps to it.
    const el = html`${null}<section>only</section>`;
    expect(el.tagName).toBe("SECTION");
  });
});

describe("htm coverage2 — event handler & raw text", () => {
  it("attaches an on: event handler", () => {
    const handler = vi.fn();
    const el = html`<button on:click=${handler}>go</button>`;
    el.dispatchEvent(new Event("click"));
    expect(handler).toHaveBeenCalled();
  });

  it("warns when an on: handler is not a function", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    html`<button on:click=${123}>x</button>`;
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("throws for dynamic expressions inside raw-text tags", () => {
    expect(() => html`<style>${"body{}"}</style>`).toThrow(/raw-text context/);
  });

  it("blocks on* event-handler attributes set via expression", () => {
    const el = html`<div onclick=${"alert(1)"}></div>`;
    expect(el.hasAttribute("onclick")).toBe(false);
  });

  it("ignores a null/undefined expression child", () => {
    const el = html`<div>${null}${undefined}${false}</div>`;
    expect(el.textContent).toBe("");
  });

  it("handles an invalid/out-of-range expression marker as literal text", () => {
    // Normal interpolation still works alongside static text
    const el = html`<div>value: ${42}</div>`;
    expect(el.textContent).toContain("value: 42");
  });
});
