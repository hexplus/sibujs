import { derived } from "../core/signals/derived";
import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";
import { batch } from "../reactivity/batch";

let selectIdCounter = 0;
const boundSelects = new WeakMap<HTMLElement, () => void>();

export interface SelectOptions<T> {
  items: T[];
  multiple?: boolean;
  itemToString?: (item: T) => string;
  /** Optional predicate marking items as disabled — such items are skipped
   *  by `highlightNext`/`highlightPrev`/typeahead and rejected by `select`. */
  isDisabled?: (item: T) => boolean;
}

export function select<T>(options: SelectOptions<T>): {
  selectedItems: () => T[];
  selectedItem: () => T | null;
  select: (item: T) => void;
  deselect: (item: T) => void;
  toggle: (item: T) => void;
  isSelected: (item: T) => boolean;
  isOpen: () => boolean;
  open: () => void;
  close: () => void;
  highlightedIndex: () => number;
  highlightNext: () => void;
  highlightPrev: () => void;
  selectHighlighted: () => void;
  clear: () => void;
  /** WAI-ARIA Listbox wiring: `role=listbox`, `aria-multiselectable`,
   *  `aria-selected`/`aria-activedescendant`, arrow + Home/End/Enter/Space
   *  + typeahead. Returns dispose. */
  bind: (els: {
    listbox: HTMLElement;
    option: (item: T, index: number) => HTMLElement | null;
    itemToString?: (item: T) => string;
  }) => () => void;
} {
  const { items, multiple = false, itemToString, isDisabled } = options;
  const isItemDisabled = isDisabled ?? (() => false);

  const [selectedItems, setSelectedItems] = signal<T[]>([]);
  const [isOpen, setIsOpen] = signal<boolean>(false);
  const [highlightedIndex, setHighlightedIndex] = signal<number>(-1);

  const selectedItem = derived<T | null>(() => {
    const sel = selectedItems();
    return sel.length > 0 ? sel[sel.length - 1] : null;
  });

  function select(item: T): void {
    if (isItemDisabled(item)) return;
    if (multiple) {
      setSelectedItems((prev) => {
        if (prev.includes(item)) return prev;
        return [...prev, item];
      });
    } else {
      batch(() => {
        setSelectedItems([item]);
        setIsOpen(false);
      });
    }
  }

  function deselect(item: T): void {
    setSelectedItems((prev) => prev.filter((i) => i !== item));
  }

  function toggle(item: T): void {
    if (selectedItems().includes(item)) {
      deselect(item);
    } else {
      select(item);
    }
  }

  function isSelected(item: T): boolean {
    return selectedItems().includes(item);
  }

  function open(): void {
    setIsOpen(true);
  }

  function close(): void {
    setIsOpen(false);
  }

  function nextEnabled(from: number, dir: 1 | -1): number {
    const len = items.length;
    if (len === 0) return -1;
    let i = from;
    for (let n = 0; n < len; n++) {
      i = (i + dir + len) % len;
      if (!isItemDisabled(items[i])) return i;
    }
    return -1;
  }

  function highlightNext(): void {
    if (items.length === 0) return;
    setHighlightedIndex((prev) => {
      const n = nextEnabled(prev < 0 ? -1 : prev, 1);
      return n === -1 ? prev : n;
    });
  }

  function highlightPrev(): void {
    if (items.length === 0) return;
    setHighlightedIndex((prev) => {
      const n = nextEnabled(prev < 0 ? items.length : prev, -1);
      return n === -1 ? prev : n;
    });
  }

  function selectHighlighted(): void {
    const idx = highlightedIndex();
    if (idx >= 0 && idx < items.length) {
      select(items[idx]);
    }
  }

  function clear(): void {
    setSelectedItems([]);
  }

  function bind(els: {
    listbox: HTMLElement;
    option: (item: T, index: number) => HTMLElement | null;
    itemToString?: (item: T) => string;
  }): () => void {
    const existing = boundSelects.get(els.listbox);
    if (existing) return existing;

    const listboxId = `sibu-select-${++selectIdCounter}`;
    els.listbox.id = listboxId;
    els.listbox.setAttribute("role", "listbox");
    els.listbox.setAttribute("aria-multiselectable", multiple ? "true" : "false");
    if (els.listbox.tabIndex < 0) els.listbox.tabIndex = 0;

    const toStr = els.itemToString ?? itemToString ?? ((it: T) => String(it));

    const fxTeardown = effect(() => {
      const idx = highlightedIndex();
      const sel = selectedItems();
      let activeId = "";
      for (let i = 0; i < items.length; i++) {
        const optEl = els.option(items[i], i);
        if (!optEl) continue;
        if (!optEl.id) optEl.id = `${listboxId}-opt-${i}`;
        optEl.setAttribute("role", "option");
        optEl.setAttribute("aria-selected", sel.includes(items[i]) ? "true" : "false");
        if (isItemDisabled(items[i])) optEl.setAttribute("aria-disabled", "true");
        else optEl.removeAttribute("aria-disabled");
        if (i === idx) activeId = optEl.id;
      }
      if (activeId) els.listbox.setAttribute("aria-activedescendant", activeId);
      else els.listbox.removeAttribute("aria-activedescendant");
    });

    // Typeahead — printable chars accumulate within a 500ms window.
    let typeBuffer = "";
    let typeTimer: ReturnType<typeof setTimeout> | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        highlightNext();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        highlightPrev();
      } else if (e.key === "Home") {
        e.preventDefault();
        if (items.length > 0) setHighlightedIndex(0);
      } else if (e.key === "End") {
        e.preventDefault();
        if (items.length > 0) setHighlightedIndex(items.length - 1);
      } else if (e.key === "Enter" || e.key === " ") {
        if (highlightedIndex() >= 0) {
          e.preventDefault();
          selectHighlighted();
        }
      } else if (e.key.length === 1 && /\S/.test(e.key)) {
        typeBuffer += e.key.toLowerCase();
        if (typeTimer !== null) clearTimeout(typeTimer);
        typeTimer = setTimeout(() => {
          typeBuffer = "";
          typeTimer = null;
        }, 500);
        const found = items.findIndex((it) => !isItemDisabled(it) && toStr(it).toLowerCase().startsWith(typeBuffer));
        if (found !== -1) setHighlightedIndex(found);
      }
    };
    els.listbox.addEventListener("keydown", onKey);

    const teardown = () => {
      boundSelects.delete(els.listbox);
      fxTeardown();
      els.listbox.removeEventListener("keydown", onKey);
      if (typeTimer !== null) clearTimeout(typeTimer);
    };
    boundSelects.set(els.listbox, teardown);
    return teardown;
  }

  return {
    selectedItems,
    selectedItem,
    select,
    deselect,
    toggle,
    isSelected,
    isOpen,
    open,
    close,
    highlightedIndex,
    highlightNext,
    highlightPrev,
    selectHighlighted,
    clear,
    bind,
  };
}
