import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentEditable } from "../src/widgets/contentEditable";

const selectContents = (el: Node): void => {
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.addRange(range);
};

const collapseSelection = (): void => {
  const sel = window.getSelection();
  sel?.removeAllRanges();
};

describe("contentEditable coverage", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    collapseSelection();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    collapseSelection();
  });

  it("starts with empty content and unfocused", () => {
    const ed = contentEditable();
    expect(ed.content()).toBe("");
    expect(ed.isFocused()).toBe(false);
  });

  it("setContent with a plain string assigns it directly (legacy form)", () => {
    const ed = contentEditable();
    // Legacy string form is treated as raw value assignment.
    ed.setContent("hello world");
    expect(ed.content()).toBe("hello world");
  });

  it("setContent with { text } assigns plain text", () => {
    const ed = contentEditable();
    ed.setContent({ text: "<b>not parsed</b>" });
    expect(ed.content()).toBe("<b>not parsed</b>");
  });

  it("setContent with { html } sanitizes by default (tags stripped)", () => {
    const ed = contentEditable();
    ed.setContent({ html: "<b>bold</b><script>alert(1)</script>" });
    expect(ed.content()).toBe("boldalert(1)");
    expect(ed.content()).not.toContain("<");
  });

  it("setContent with { html, sanitize: false } keeps raw html", () => {
    const ed = contentEditable();
    ed.setContent({ html: "<b>raw</b>", sanitize: false });
    expect(ed.content()).toBe("<b>raw</b>");
  });

  it("setContent with an empty options object resets to empty string", () => {
    const ed = contentEditable();
    ed.setContent("seed");
    ed.setContent({});
    expect(ed.content()).toBe("");
  });

  it("setFocused updates the focused signal", () => {
    const ed = contentEditable();
    ed.setFocused(true);
    expect(ed.isFocused()).toBe(true);
    ed.setFocused(false);
    expect(ed.isFocused()).toBe(false);
  });

  it("bold wraps the current selection in <strong>", () => {
    const ed = contentEditable();
    const host = document.createElement("div");
    host.contentEditable = "true";
    host.textContent = "wrap me";
    document.body.appendChild(host);
    selectContents(host);

    ed.bold();
    expect(host.querySelector("strong")).not.toBeNull();
    expect(host.querySelector("strong")?.textContent).toBe("wrap me");
  });

  it("italic wraps the selection in <em>", () => {
    const ed = contentEditable();
    const host = document.createElement("div");
    host.textContent = "emphasis";
    document.body.appendChild(host);
    selectContents(host);
    ed.italic();
    expect(host.querySelector("em")).not.toBeNull();
  });

  it("underline wraps the selection in <u>", () => {
    const ed = contentEditable();
    const host = document.createElement("div");
    host.textContent = "underlined";
    document.body.appendChild(host);
    selectContents(host);
    ed.underline();
    expect(host.querySelector("u")).not.toBeNull();
  });

  it("toggling bold a second time unwraps the existing <strong>", () => {
    const ed = contentEditable();
    const host = document.createElement("div");
    host.textContent = "toggle";
    document.body.appendChild(host);

    selectContents(host);
    ed.bold();
    expect(host.querySelector("strong")).not.toBeNull();

    // Select the wrapped content again and toggle off.
    const strong = host.querySelector("strong");
    if (strong) selectContents(strong);
    ed.bold();
    expect(host.querySelector("strong")).toBeNull();
    expect(host.textContent).toBe("toggle");
  });

  it("is a no-op when the selection is collapsed", () => {
    const ed = contentEditable();
    const host = document.createElement("div");
    host.textContent = "no selection";
    document.body.appendChild(host);
    collapseSelection();
    ed.bold();
    expect(host.querySelector("strong")).toBeNull();
  });

  it("is a no-op when there is no selection range", () => {
    const ed = contentEditable();
    const sel = window.getSelection();
    sel?.removeAllRanges();
    expect(() => ed.italic()).not.toThrow();
  });

  it("falls back to extract/insert when surroundContents throws across boundaries", () => {
    const ed = contentEditable();
    const host = document.createElement("div");
    // Two separate text-bearing children so a range spanning both crosses
    // element boundaries and makes surroundContents throw.
    const a = document.createElement("span");
    a.textContent = "AAA";
    const b = document.createElement("span");
    b.textContent = "BBB";
    host.appendChild(a);
    host.appendChild(b);
    document.body.appendChild(host);

    const sel = window.getSelection();
    sel?.removeAllRanges();
    const range = document.createRange();
    range.setStart(a.firstChild as Node, 1);
    range.setEnd(b.firstChild as Node, 2);
    sel?.addRange(range);

    ed.bold();
    // The fallback path wraps the extracted fragment in <strong>.
    expect(host.querySelector("strong")).not.toBeNull();
  });
});
