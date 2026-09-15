import { signal } from "../core/signals/signal";
import { stripHtml } from "../utils/sanitize";

/**
 * Reduce an HTML string to text that stays inert if it is rendered as HTML
 * again.
 *
 * One `stripHtml` pass removes the markup and decodes entities, so an encoded
 * payload (`&lt;img onerror=…&gt;`) comes out shaped like a tag. Stripping
 * again until stable made it inert, but also deleted text that was encoded on
 * purpose (`&amp;lt;b&amp;gt;` — "the <b> tag" — vanished). Instead, every `<`
 * that would open a tag is re-escaped: nothing is lost, and rendering the
 * result as HTML still creates no element.
 */
function toInertText(html: string): string {
  return stripHtml(String(html)).replace(/<(?=[a-z!/?])/gi, "&lt;");
}

/**
 * Options for `setContent`.
 *
 * WARNING: passing `sanitize: false` bypasses the built-in protection and
 * requires the caller to guarantee the HTML has already been sanitized with
 * a trusted library. Any untrusted input that reaches `setContent` with
 * `sanitize: false` is an XSS vector.
 */
export interface SetContentOptions {
  /** Raw HTML to assign. Sanitized by default (tags are stripped). */
  html?: string;
  /** Plain text. Always safe — assigned via `textContent`. */
  text?: string;
  /**
   * When true (default), `html` is run through the framework's HTML
   * stripper before assignment — tags are removed, only text content is
   * preserved. Set to `false` ONLY when `html` has already been sanitized
   * with a dedicated library (e.g. DOMPurify).
   */
  sanitize?: boolean;
}

/**
 * contentEditable provides reactive binding for contenteditable elements.
 *
 * Uses the modern Selection/Range API instead of the deprecated
 * document.execCommand. Formatting is applied by wrapping the current
 * selection in the appropriate inline element.
 *
 * @param element Optional editor element to scope formatting to. When provided,
 *   `bold()`/`italic()`/`underline()` ignore any selection that lives outside it
 *   — otherwise a selection elsewhere on the page could be mutated, since the
 *   Selection API is global.
 */
export function contentEditable(element?: HTMLElement): {
  content: () => string;
  /**
   * Update the reactive content value.
   *
   * - `setContent("<b>x</b>")` — LEGACY: treated as `{ html, sanitize: true }`.
   *   The HTML is stripped to text by default to prevent XSS. Prefer the
   *   options form below.
   * - `setContent({ text: "hello" })` — plain text, always safe.
   * - `setContent({ html, sanitize: true })` — sanitized HTML (default).
   * - `setContent({ html, sanitize: false })` — raw HTML; the caller MUST
   *   have pre-sanitized it with a trusted library (e.g. DOMPurify).
   */
  setContent: (input: string | SetContentOptions) => void;
  isFocused: () => boolean;
  setFocused: (v: boolean) => void;
  bold: () => void;
  italic: () => void;
  underline: () => void;
} {
  const [content, setContentInternal] = signal<string>("");
  const [isFocused, setFocused] = signal<boolean>(false);

  function setContent(input: string | SetContentOptions): void {
    // The legacy string form is documented as `{ html, sanitize: true }` and is
    // handled exactly that way; raw HTML is reachable only through
    // `{ html, sanitize: false }`.
    if (typeof input === "string") {
      setContentInternal(toInertText(input));
      return;
    }
    if (typeof input.text === "string") {
      setContentInternal(input.text);
      return;
    }
    if (typeof input.html === "string") {
      const shouldSanitize = input.sanitize !== false;
      setContentInternal(shouldSanitize ? toInertText(input.html) : input.html);
      return;
    }
    setContentInternal("");
  }

  /**
   * Wrap the current selection in an inline element (e.g. <strong>, <em>, <u>).
   * If there is no selection, this is a no-op.
   */
  function wrapSelection(tagName: string): void {
    if (typeof window === "undefined") return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);

    // Scope formatting to the bound editor: ignore a selection that lives
    // outside it (e.g. text selected elsewhere on the page) so the formatting
    // commands can't mutate unrelated DOM.
    if (element && !element.contains(range.commonAncestorContainer)) return;

    // Check if we're already inside the same tag — if so, unwrap
    const ancestor = range.commonAncestorContainer;
    const existingWrap = findWrapperWithinEditor(
      ancestor instanceof HTMLElement ? ancestor : ancestor.parentElement,
      tagName,
    );

    let targetNode: Node | null = null;

    if (existingWrap) {
      // Unwrap: replace the wrapper with its children
      const parent = existingWrap.parentNode;
      if (parent) {
        const firstChild = existingWrap.firstChild;
        const lastChild = existingWrap.lastChild;
        while (existingWrap.firstChild) {
          parent.insertBefore(existingWrap.firstChild, existingWrap);
        }
        parent.removeChild(existingWrap);

        // Re-select the unwrapped content range
        if (firstChild && lastChild) {
          const newRange = document.createRange();
          newRange.setStartBefore(firstChild);
          newRange.setEndAfter(lastChild);
          selection.removeAllRanges();
          selection.addRange(newRange);
          return;
        }
      }
    } else {
      // Wrap: surround the selection with the tag
      const wrapper = document.createElement(tagName);
      try {
        range.surroundContents(wrapper);
      } catch {
        // surroundContents fails if selection crosses element boundaries;
        // fall back to extracting and re-inserting
        const fragment = range.extractContents();
        wrapper.appendChild(fragment);
        range.insertNode(wrapper);
      }
      targetNode = wrapper;
    }

    // Restore selection around the wrapper
    if (targetNode) {
      selection.removeAllRanges();
      const newRange = document.createRange();
      newRange.selectNodeContents(targetNode);
      selection.addRange(newRange);
    }
  }

  /**
   * Find an existing `tagName` wrapper around the selection that belongs to the
   * editor. The walk stops at the bound editor element and at the nearest
   * editing host (an element with `contenteditable` other than "false"),
   * whichever comes first — neither the boundary itself nor anything above it
   * is ever returned. An unbounded walk used to find a `<strong>` that
   * CONTAINED the editor and unwrap it, rewriting unrelated sibling DOM.
   */
  function findWrapperWithinEditor(el: Element | null, tagName: string): HTMLElement | null {
    const upper = tagName.toUpperCase();
    while (el) {
      if (el === element || isEditingHost(el)) return null;
      if (el.tagName === upper) return el as HTMLElement;
      el = el.parentElement;
    }
    return null;
  }

  function isEditingHost(el: Element): boolean {
    const attr = el.getAttribute("contenteditable");
    return attr !== null && attr.toLowerCase() !== "false";
  }

  function bold(): void {
    wrapSelection("strong");
  }

  function italic(): void {
    wrapSelection("em");
  }

  function underline(): void {
    wrapSelection("u");
  }

  return {
    content,
    setContent,
    isFocused,
    setFocused,
    bold,
    italic,
    underline,
  };
}
