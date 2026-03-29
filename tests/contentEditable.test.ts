import { afterEach, describe, expect, it, vi } from "vitest";
import { contentEditable } from "../src/widgets/contentEditable";

describe("contentEditable", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with empty content and not focused", () => {
    const editor = contentEditable();
    expect(editor.content()).toBe("");
    expect(editor.isFocused()).toBe(false);
  });

  it("sets and reads content", () => {
    const editor = contentEditable();
    editor.setContent("<b>Hello</b>");
    expect(editor.content()).toBe("<b>Hello</b>");
  });

  it("tracks focus state", () => {
    const editor = contentEditable();
    editor.setFocused(true);
    expect(editor.isFocused()).toBe(true);
    editor.setFocused(false);
    expect(editor.isFocused()).toBe(false);
  });

  it("bold() does not throw when no selection", () => {
    const editor = contentEditable();
    expect(() => editor.bold()).not.toThrow();
  });

  it("italic() does not throw when no selection", () => {
    const editor = contentEditable();
    expect(() => editor.italic()).not.toThrow();
  });

  it("underline() does not throw when no selection", () => {
    const editor = contentEditable();
    expect(() => editor.underline()).not.toThrow();
  });

  it("does not throw when window is unavailable", () => {
    vi.stubGlobal("window", undefined);
    const editor = contentEditable();
    expect(() => editor.bold()).not.toThrow();
    expect(() => editor.italic()).not.toThrow();
    expect(() => editor.underline()).not.toThrow();
  });

  it("bold() wraps selection in <strong> when selection exists", () => {
    // Set up a contenteditable div with text
    const container = document.createElement("div");
    container.setAttribute("contenteditable", "true");
    container.textContent = "Hello World";
    document.body.appendChild(container);

    // Create a selection on "World"
    const textNode = container.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 11);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const editor = contentEditable();
    editor.bold();

    // The selection should have been wrapped in <strong>
    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong?.textContent).toBe("World");

    document.body.removeChild(container);
  });

  it("italic() wraps selection in <em>", () => {
    const container = document.createElement("div");
    container.setAttribute("contenteditable", "true");
    container.textContent = "Hello World";
    document.body.appendChild(container);

    const textNode = container.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const editor = contentEditable();
    editor.italic();

    const em = container.querySelector("em");
    expect(em).not.toBeNull();
    expect(em?.textContent).toBe("Hello");

    document.body.removeChild(container);
  });

  it("underline() wraps selection in <u>", () => {
    const container = document.createElement("div");
    container.setAttribute("contenteditable", "true");
    container.textContent = "Hello World";
    document.body.appendChild(container);

    const textNode = container.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const editor = contentEditable();
    editor.underline();

    const u = container.querySelector("u");
    expect(u).not.toBeNull();
    expect(u?.textContent).toBe("Hello");

    document.body.removeChild(container);
  });

  it("bold() unwraps existing <strong> (toggle off)", () => {
    const container = document.createElement("div");
    container.setAttribute("contenteditable", "true");
    container.innerHTML = "Hello <strong>World</strong>";
    document.body.appendChild(container);

    // Select the text inside <strong>
    const strongEl = container.querySelector("strong")!;
    const textNode = strongEl.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const editor = contentEditable();
    editor.bold();

    // <strong> should be removed
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toBe("Hello World");

    document.body.removeChild(container);
  });

  it("does not wrap when selection is collapsed", () => {
    const container = document.createElement("div");
    container.setAttribute("contenteditable", "true");
    container.textContent = "Hello";
    document.body.appendChild(container);

    const textNode = container.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, 2); // collapsed
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const editor = contentEditable();
    editor.bold();

    // Should not create a <strong> element
    expect(container.querySelector("strong")).toBeNull();

    document.body.removeChild(container);
  });
});
