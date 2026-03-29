import { signal } from "../core/signals/signal";

/**
 * contentEditable provides reactive binding for contenteditable elements.
 *
 * Uses the modern Selection/Range API instead of the deprecated
 * document.execCommand. Formatting is applied by wrapping the current
 * selection in the appropriate inline element.
 */
export function contentEditable(): {
  content: () => string;
  setContent: (html: string) => void;
  isFocused: () => boolean;
  setFocused: (v: boolean) => void;
  bold: () => void;
  italic: () => void;
  underline: () => void;
} {
  const [content, setContent] = signal<string>("");
  const [isFocused, setFocused] = signal<boolean>(false);

  /**
   * Wrap the current selection in an inline element (e.g. <strong>, <em>, <u>).
   * If there is no selection, this is a no-op.
   */
  function wrapSelection(tagName: string): void {
    if (typeof window === "undefined") return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);

    // Check if we're already inside the same tag — if so, unwrap
    const ancestor = range.commonAncestorContainer;
    const existingWrap = findAncestorByTag(
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

  function findAncestorByTag(el: Element | null, tagName: string): HTMLElement | null {
    const upper = tagName.toUpperCase();
    while (el) {
      if (el.tagName === upper) return el as HTMLElement;
      el = el.parentElement;
    }
    return null;
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
