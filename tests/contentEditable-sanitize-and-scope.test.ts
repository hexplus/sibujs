import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentEditable } from "../src/widgets/contentEditable";

// ---------------------------------------------------------------------------
// contentEditable: string content is sanitized, and formatting never reaches
// outside the editor.
//
// THE DEFECTS:
// 1. `setContent(string)` is documented as `{ html, sanitize: true }` but stored
//    the string unchanged, so `content()` rendered as HTML carried live markup.
// 2. The selection was checked to be inside the editor, but the lookup for an
//    existing wrapper kept climbing past the editor, so `bold()` could unwrap a
//    `<strong>` that CONTAINED the editor — rewriting unrelated sibling DOM.
// ---------------------------------------------------------------------------

function selectText(node: Node, start = 0, end?: number): void {
  const range = document.createRange();
  const text = node.nodeType === Node.TEXT_NODE ? node : node.firstChild;
  if (!text) throw new Error("no text node to select");
  range.setStart(text, start);
  range.setEnd(text, end ?? (text.textContent ?? "").length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

beforeEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("setContent(string) sanitizes", () => {
  const PAYLOADS: [string, string][] = [
    ["event handler", '<img src=x onerror="attack()">'],
    ["script", "<script>attack()</script>"],
    ["svg onload", '<svg onload="attack()"><circle r="1"/></svg>'],
    ["malformed", '<img src=x onerror="attack()"'],
    ["unclosed nested", "<div><p><b onclick=attack()>x"],
    ["html-encoded", "&lt;img src=x onerror=attack()&gt;"],
    ["double-encoded", "&amp;lt;img src=x onerror=attack()&amp;gt;"],
  ];

  for (const [label, payload] of PAYLOADS) {
    it(`removes markup: ${label}`, () => {
      const editor = contentEditable();
      editor.setContent(payload);

      const value = editor.content();
      expect(value).not.toMatch(/<[a-z!/?]/i);
      expect(value).not.toContain("onerror=");
      expect(value).not.toContain("onload=");

      // Rendering the stored value as HTML creates no elements at all.
      const probe = document.createElement("div");
      probe.innerHTML = value;
      expect(probe.children).toHaveLength(0);
    });
  }

  it("keeps the text content of formatted markup", () => {
    const editor = contentEditable();
    editor.setContent("<b>Hello</b> <i>world</i>");
    expect(editor.content()).toBe("Hello world");
  });

  it("leaves plain text unchanged", () => {
    const editor = contentEditable();
    editor.setContent("Plain text, 5 > 3 and a & b");
    expect(editor.content()).toBe("Plain text, 5 > 3 and a & b");
  });

  it("{ html } with default sanitization applies the same protection", () => {
    const editor = contentEditable();
    editor.setContent({ html: "&lt;img src=x onerror=attack()&gt;" });
    expect(editor.content()).not.toMatch(/<[a-z]/i);
  });

  it("{ html, sanitize: false } remains the only raw-HTML path", () => {
    const editor = contentEditable();
    editor.setContent({ html: "<b>raw</b>", sanitize: false });
    expect(editor.content()).toBe("<b>raw</b>");
  });
});

describe("formatting stays inside the editor", () => {
  it("never unwraps a matching ancestor outside the bound editor", () => {
    document.body.innerHTML =
      '<strong id="outside"><div id="editor" contenteditable="true">selected text</div><span id="sibling">unrelated sibling</span></strong>';
    const outside = document.getElementById("outside")!;
    const editor = document.getElementById("editor")!;
    const sibling = document.getElementById("sibling")!;

    selectText(editor.firstChild!, 0, 8);
    contentEditable(editor).bold();

    expect(document.getElementById("outside")).toBe(outside);
    expect(outside.contains(editor)).toBe(true);
    expect(outside.contains(sibling)).toBe(true);
    expect(sibling.textContent).toBe("unrelated sibling");
    // The selection was wrapped inside the editor instead.
    expect(editor.querySelector("strong")?.textContent).toBe("selected");
  });

  it("never unwraps an ancestor outside the editing host when no editor is bound", () => {
    document.body.innerHTML =
      '<strong id="outside"><div id="editor" contenteditable="true">selected text</div><span>sibling</span></strong>';
    const outside = document.getElementById("outside")!;
    const editor = document.getElementById("editor")!;

    selectText(editor.firstChild!, 0, 8);
    contentEditable().bold();

    expect(document.getElementById("outside")).toBe(outside);
    expect(editor.querySelector("strong")?.textContent).toBe("selected");
  });

  it("still unwraps a matching wrapper inside the editor", () => {
    document.body.innerHTML = '<div id="editor" contenteditable="true">Hello <strong id="inner">World</strong></div>';
    const editor = document.getElementById("editor")!;

    selectText(document.getElementById("inner")!.firstChild!);
    contentEditable(editor).bold();

    expect(editor.querySelector("strong")).toBeNull();
    expect(editor.textContent).toBe("Hello World");
  });

  it("does not cross into an outer editor from a nested editor", () => {
    document.body.innerHTML =
      '<div id="outer" contenteditable="true"><strong id="between"><div id="inner" contenteditable="true">nested text</div></strong></div>';
    const outer = document.getElementById("outer")!;
    const between = document.getElementById("between")!;
    const inner = document.getElementById("inner")!;

    selectText(inner.firstChild!, 0, 6);
    contentEditable(outer).bold();

    expect(document.getElementById("between")).toBe(between);
    expect(between.contains(inner)).toBe(true);
    expect(inner.querySelector("strong")?.textContent).toBe("nested");
  });

  it("the editor element itself is never unwrapped", () => {
    document.body.innerHTML = '<strong id="editor" contenteditable="true">bold editor</strong>';
    const editor = document.getElementById("editor")!;

    selectText(editor.firstChild!, 0, 4);
    contentEditable(editor).bold();

    expect(document.getElementById("editor")).toBe(editor);
    expect(editor.isConnected).toBe(true);
  });
});
