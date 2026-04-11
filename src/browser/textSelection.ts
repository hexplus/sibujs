import { signal } from "../core/signals/signal";

export interface TextSelectionState {
  /** Selected text, or empty string. */
  text: () => string;
  /** DOMRect of the selection (for positioning floating action bars) or null. */
  rect: () => DOMRect | null;
  /** True when there is a non-empty selection. */
  hasSelection: () => boolean;
  /** Programmatically clear the current selection. */
  clear: () => void;
  dispose: () => void;
}

/**
 * textSelection tracks the user's current text selection as reactive state.
 * Great for "selection toolbars" (bold/italic popovers), citation tools,
 * and any UI that needs to show contextual actions when the user highlights
 * text on the page.
 *
 * Listens to `selectionchange` on the document, which fires for mouse drag,
 * keyboard selection (Shift+arrow), and touch selection all the same.
 *
 * @example
 * ```ts
 * const sel = textSelection();
 * effect(() => {
 *   const rect = sel.rect();
 *   if (rect) positionToolbar(rect);
 *   else hideToolbar();
 * });
 * ```
 */
export function textSelection(): TextSelectionState {
  const [text, setText] = signal("");
  const [rect, setRect] = signal<DOMRect | null>(null);

  if (typeof document === "undefined") {
    return {
      text,
      rect,
      hasSelection: () => false,
      clear: () => {},
      dispose: () => {},
    };
  }

  const handler = () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      setText("");
      setRect(null);
      return;
    }
    setText(sel.toString());
    try {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      setRect(r.width > 0 || r.height > 0 ? r : null);
    } catch {
      setRect(null);
    }
  };

  document.addEventListener("selectionchange", handler);

  function clear() {
    const sel = document.getSelection();
    sel?.removeAllRanges();
    setText("");
    setRect(null);
  }

  function dispose() {
    document.removeEventListener("selectionchange", handler);
  }

  return {
    text,
    rect,
    hasSelection: () => text().length > 0,
    clear,
    dispose,
  };
}
