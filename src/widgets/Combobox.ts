import { derived } from "../core/signals/derived";
import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";
import { watch } from "../core/signals/watch";
import { batch } from "../reactivity/batch";

let comboboxIdCounter = 0;
const boundComboboxes = new WeakMap<HTMLElement, () => void>();

export interface ComboboxOptions<T> {
  items: T[];
  filterFn?: (item: T, query: string) => boolean;
  itemToString?: (item: T) => string;
}

export function combobox<T>(options: ComboboxOptions<T>): {
  query: () => string;
  setQuery: (q: string) => void;
  filteredItems: () => T[];
  selectedItem: () => T | null;
  select: (item: T) => void;
  highlightedIndex: () => number;
  highlightNext: () => void;
  highlightPrev: () => void;
  selectHighlighted: () => void;
  isOpen: () => boolean;
  open: () => void;
  close: () => void;
  /** WAI-ARIA Combobox 1.2 wiring: `role=combobox` on input,
   *  `aria-expanded`/`aria-controls`/`aria-activedescendant`, listbox option
   *  ids, Down/Up/Enter/Escape/Home/End. Returns dispose. */
  bind: (els: {
    input: HTMLInputElement;
    listbox: HTMLElement;
    option: (item: T, index: number) => HTMLElement | null;
  }) => () => void;
} {
  const { items, filterFn, itemToString } = options;

  const defaultFilterFn = (item: T, q: string): boolean => {
    const str = itemToString ? itemToString(item) : String(item);
    return str.toLowerCase().includes(q.toLowerCase());
  };

  const filter = filterFn ?? defaultFilterFn;

  const [query, setQuery] = signal<string>("");
  const [selectedItem, setSelectedItem] = signal<T | null>(null);
  const [highlightedIndex, setHighlightedIndex] = signal<number>(-1);
  const [isOpen, setIsOpen] = signal<boolean>(false);

  const filteredItems = derived<T[]>(() => {
    const q = query();
    if (q === "") return items;
    return items.filter((item) => filter(item, q));
  });

  // Reset highlighted index when the query changes (skips initial value)
  watch(query, () => {
    setHighlightedIndex(-1);
  });

  function select(item: T): void {
    batch(() => {
      setSelectedItem(item);
      const str = itemToString ? itemToString(item) : String(item);
      setQuery(str);
      setIsOpen(false);
    });
  }

  function highlightNext(): void {
    const filtered = filteredItems();
    if (filtered.length === 0) return;
    setHighlightedIndex((prev) => {
      const next = prev + 1;
      return next >= filtered.length ? 0 : next;
    });
  }

  function highlightPrev(): void {
    const filtered = filteredItems();
    if (filtered.length === 0) return;
    setHighlightedIndex((prev) => {
      const next = prev - 1;
      return next < 0 ? filtered.length - 1 : next;
    });
  }

  function selectHighlighted(): void {
    const filtered = filteredItems();
    const idx = highlightedIndex();
    if (idx >= 0 && idx < filtered.length) {
      select(filtered[idx]);
    }
  }

  function open(): void {
    setIsOpen(true);
  }

  function close(): void {
    setIsOpen(false);
  }

  function bind(els: {
    input: HTMLInputElement;
    listbox: HTMLElement;
    option: (item: T, index: number) => HTMLElement | null;
  }): () => void {
    const existing = boundComboboxes.get(els.input);
    if (existing) return existing;

    const listboxId = `sibu-combobox-listbox-${++comboboxIdCounter}`;
    els.listbox.id = listboxId;
    els.listbox.setAttribute("role", "listbox");
    els.input.setAttribute("role", "combobox");
    els.input.setAttribute("aria-autocomplete", "list");
    els.input.setAttribute("aria-controls", listboxId);

    const fxTeardown = effect(() => {
      const open = isOpen();
      els.input.setAttribute("aria-expanded", open ? "true" : "false");
      els.listbox.hidden = !open;

      const idx = highlightedIndex();
      const filtered = filteredItems();
      let activeId = "";
      for (let i = 0; i < filtered.length; i++) {
        const optEl = els.option(filtered[i], i);
        if (!optEl) continue;
        if (!optEl.id) optEl.id = `${listboxId}-opt-${i}`;
        optEl.setAttribute("role", "option");
        const isHighlighted = i === idx;
        optEl.setAttribute("aria-selected", isHighlighted ? "true" : "false");
        if (isHighlighted) activeId = optEl.id;
      }
      if (activeId) els.input.setAttribute("aria-activedescendant", activeId);
      else els.input.removeAttribute("aria-activedescendant");
    });

    const onInput = () => {
      setQuery(els.input.value);
      open();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!isOpen()) open();
        highlightNext();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!isOpen()) open();
        highlightPrev();
      } else if (e.key === "Enter") {
        if (highlightedIndex() >= 0) {
          e.preventDefault();
          selectHighlighted();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Home") {
        e.preventDefault();
        if (filteredItems().length > 0) setHighlightedIndex(0);
      } else if (e.key === "End") {
        e.preventDefault();
        const len = filteredItems().length;
        if (len > 0) setHighlightedIndex(len - 1);
      }
    };
    let blurTimer: ReturnType<typeof setTimeout> | null = null;
    const onFocus = () => open();
    const onBlur = () => {
      // Slight delay so click on listbox option lands before close.
      if (blurTimer !== null) clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        blurTimer = null;
        if (document.activeElement !== els.input) close();
      }, 100);
    };

    els.input.addEventListener("input", onInput);
    els.input.addEventListener("keydown", onKey);
    els.input.addEventListener("focus", onFocus);
    els.input.addEventListener("blur", onBlur);

    const teardown = () => {
      boundComboboxes.delete(els.input);
      fxTeardown();
      els.input.removeEventListener("input", onInput);
      els.input.removeEventListener("keydown", onKey);
      els.input.removeEventListener("focus", onFocus);
      els.input.removeEventListener("blur", onBlur);
      if (blurTimer !== null) {
        clearTimeout(blurTimer);
        blurTimer = null;
      }
    };
    boundComboboxes.set(els.input, teardown);
    return teardown;
  }

  return {
    query,
    setQuery,
    filteredItems,
    selectedItem,
    select,
    highlightedIndex,
    highlightNext,
    highlightPrev,
    selectHighlighted,
    isOpen,
    open,
    close,
    bind,
  };
}
