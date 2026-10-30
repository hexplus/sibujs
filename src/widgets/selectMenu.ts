import { createId } from "../core/rendering/createId";
import { signal } from "../core/signals/signal";
import { batch } from "../reactivity/batch";
import { domBinding } from "../reactivity/domBinding";
import { untracked } from "../reactivity/track";
import { snapshotAttributes } from "./attributeSnapshot";
import { claimWidgetKey, isWidgetKeyEvent } from "./keyOwnership";

const boundMenus = new WeakMap<HTMLElement, () => void>();

/** Attributes `bind()` writes on each option element, restored on dispose. */
const OPTION_ATTRS = ["id", "role", "aria-selected", "aria-disabled"];

export interface SelectMenuOptions<T> {
  /** The options, in display order. A getter makes the list reactive. */
  items: T[] | (() => T[]);
  /**
   * The selected item, CONTROLLED: read through this getter, changed only by
   * the app in response to `onChange`. Omit it for an uncontrolled menu that
   * keeps its own selection (seeded by `defaultValue`).
   */
  value?: () => T | null | undefined;
  /** Initial selection of an uncontrolled menu. */
  defaultValue?: T | null;
  /** Called when the user commits an option (Enter, Space, click, Tab, Alt+Up). */
  onChange?: (item: T) => void;
  /** Text used by typeahead. Defaults to `String(item)`. */
  itemToString?: (item: T) => string;
  /** Disabled options are skipped by navigation and typeahead and cannot be committed. */
  isDisabled?: (item: T) => boolean;
  /** Identity of two items, used to find the selected one. Defaults to `Object.is`. */
  isEqual?: (a: T, b: T) => boolean;
  /** How far PageUp / PageDown move the active option. Defaults to 10. */
  pageSize?: number;
}

export interface SelectMenuElements<T> {
  /** The element that shows the value and opens the list — usually a `<button>`. */
  trigger: HTMLElement;
  /** The popup list. Hidden while the menu is closed. */
  listbox: HTMLElement;
  /** The element rendering `item`, or null when it is not in the DOM. */
  option: (item: T, index: number) => HTMLElement | null;
}

export interface SelectMenu<T> {
  /** The committed selection. */
  value: () => T | null;
  /** Whether the popup list is showing. */
  isOpen: () => boolean;
  /**
   * Show the list. The active option is the selected one (or the first enabled
   * option); pass `"first"` or `"last"` to start from an end instead.
   */
  open: (activeAt?: "selected" | "first" | "last") => void;
  /** Hide the list without changing the selection. */
  close: () => void;
  /** Open when closed, close when open. */
  toggle: () => void;
  /** Index of the option the keyboard is on (visual focus), or -1. */
  active: () => number;
  /** The item at {@link active}, or null. */
  activeItem: () => T | null;
  /** Move visual focus to `index` (ignored for a disabled or missing option). */
  setActive: (index: number) => void;
  /** Commit `item` as if the user picked it: calls `onChange`, closes the list. */
  select: (item: T) => void;
  /**
   * WAI-ARIA APG "select-only combobox" wiring. The trigger gets
   * `role=combobox`, `aria-haspopup=listbox`, `aria-expanded`, `aria-controls`
   * and `aria-activedescendant`; the listbox and options get their roles,
   * ids, `aria-selected` and `aria-disabled`. Keyboard, pointer, outside click
   * and focus return are handled. Returns dispose, which restores every
   * attribute it touched.
   */
  bind: (els: SelectMenuElements<T>) => () => void;
}

/**
 * Headless "select-only combobox": a button that opens a popup list of options
 * whose content is arbitrary DOM — a font name in its own typeface, a swatch,
 * an icon — which a native `<select>` cannot render.
 *
 * Follows the WAI-ARIA APG select-only combobox pattern: focus stays on the
 * trigger and the list is navigated through `aria-activedescendant`.
 *
 * Keys it acts on are claimed (see `isWidgetKeyEvent`), so a page-level
 * shortcut handler can leave them alone.
 *
 * @param options Items, selection (controlled or not) and item helpers.
 * @returns Menu state and a `bind()` that wires it to your markup.
 *
 * @example
 * ```ts
 * const menu = selectMenu({ items: FONTS, value: () => font(), onChange: setFont, itemToString: (f) => f.label });
 * const optionEls = FONTS.map((f) => li({ style: { fontFamily: f.css } }, f.label));
 * const list = ul(optionEls);
 * const trigger = button(() => menu.value()?.label ?? "Choose a font");
 * menu.bind({ trigger, listbox: list, option: (_f, i) => optionEls[i] });
 * ```
 */
export function selectMenu<T>(options: SelectMenuOptions<T>): SelectMenu<T> {
  const getItems: () => T[] = typeof options.items === "function" ? options.items : () => options.items as T[];
  const toStr = options.itemToString ?? ((item: T) => String(item));
  const isDisabled = options.isDisabled ?? (() => false);
  const isEqual = options.isEqual ?? Object.is;
  const pageSize = Math.max(1, options.pageSize ?? 10);

  const [ownValue, setOwnValue] = signal<T | null>(options.defaultValue ?? null);
  const readValue = options.value;
  const value = (): T | null => (readValue ? (readValue() ?? null) : ownValue());

  const [isOpen, setIsOpen] = signal(false);
  const [active, setActiveIndex] = signal(-1);

  const enabledAt = (items: T[], i: number): boolean => i >= 0 && i < items.length && !isDisabled(items[i]);

  /** The nearest enabled index from `from` (inclusive) in direction `dir`, or -1. */
  function enabledFrom(items: T[], from: number, dir: 1 | -1): number {
    for (let i = from; i >= 0 && i < items.length; i += dir) if (!isDisabled(items[i])) return i;
    return -1;
  }

  function selectedIndex(items: T[]): number {
    const v = value();
    if (v === null) return -1;
    return items.findIndex((it) => isEqual(it, v));
  }

  function open(activeAt: "selected" | "first" | "last" = "selected"): void {
    untracked(() => {
      const items = getItems();
      let idx = -1;
      if (activeAt === "last") idx = enabledFrom(items, items.length - 1, -1);
      else if (activeAt === "first") idx = enabledFrom(items, 0, 1);
      else {
        const sel = selectedIndex(items);
        idx = enabledAt(items, sel) ? sel : enabledFrom(items, 0, 1);
      }
      batch(() => {
        setActiveIndex(idx);
        setIsOpen(true);
      });
    });
  }

  function close(): void {
    setIsOpen(false);
  }

  function toggle(): void {
    if (untracked(isOpen)) close();
    else open();
  }

  function setActive(index: number): void {
    if (enabledAt(untracked(getItems), index)) setActiveIndex(index);
  }

  function select(item: T): void {
    if (isDisabled(item)) return;
    batch(() => {
      if (!readValue) setOwnValue(() => item);
      setIsOpen(false);
    });
    options.onChange?.(item);
  }

  function activeItem(): T | null {
    const items = getItems();
    const i = active();
    return i >= 0 && i < items.length ? items[i] : null;
  }

  function bind(els: SelectMenuElements<T>): () => void {
    const existing = boundMenus.get(els.trigger);
    if (existing) return existing;
    const { trigger, listbox } = els;

    const restoreTrigger = snapshotAttributes(trigger, [
      "role",
      "aria-haspopup",
      "aria-expanded",
      "aria-controls",
      "aria-activedescendant",
      "tabindex",
    ]);
    const restoreListbox = snapshotAttributes(listbox, ["id", "role", "tabindex"]);
    const prevHidden = listbox.hidden;
    // Options are discovered lazily (the list may be reactive), so each one is
    // snapshotted the first time bind() writes to it, and given back as soon as
    // it leaves the list — the binding never holds an option it no longer shows.
    const optionRestores = new Map<HTMLElement, () => void>();
    // The id generated for an element that had none. Allocated from the shared
    // monotonic counter, never from the element's index: an index is reused
    // when an option is inserted before another, which gave two options the
    // same id and made `aria-activedescendant` ambiguous. Weak, so an element
    // that returns to the list gets its id back without being retained.
    const generatedIds = new WeakMap<HTMLElement, string>();
    // Option element → index, rebuilt on every pass, for pointer handling.
    let optionIndex = new Map<HTMLElement, number>();

    const listboxId = listbox.id || createId("sibu-select-menu");
    listbox.id = listboxId;
    listbox.setAttribute("role", "listbox");
    // Clickable but not a tab stop: focus stays on the trigger.
    listbox.tabIndex = -1;
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-controls", listboxId);
    if (trigger.tabIndex < 0) trigger.tabIndex = 0;

    const generatedIdFor = (el: HTMLElement, taken: ReadonlySet<string>): string => {
      let id = generatedIds.get(el);
      // Skip an id the page or another option already uses, so a generated id
      // never collides with an author-supplied one.
      while (id === undefined || taken.has(id) || el.ownerDocument.getElementById(id) !== null) {
        id = createId(`${listboxId}-opt`);
      }
      generatedIds.set(el, id);
      return id;
    };

    let lastScrolled: HTMLElement | null = null;
    const stopBinding = domBinding(() => {
      const items = getItems();
      const openNow = isOpen();
      const idx = active();
      const sel = value();
      trigger.setAttribute("aria-expanded", openNow ? "true" : "false");
      listbox.hidden = !openNow;

      const nextIndex = new Map<HTMLElement, number>();
      let activeEl: HTMLElement | null = null;
      // Collected first, so a generated id can avoid every id the options of
      // this pass already carry — including author ids on elements that are
      // not in the document yet, which `getElementById` cannot see.
      const optionEls: Array<HTMLElement | null> = [];
      const taken = new Set<string>();
      for (let i = 0; i < items.length; i++) {
        const el = els.option(items[i], i);
        optionEls.push(el);
        if (el?.id) taken.add(el.id);
      }
      for (let i = 0; i < items.length; i++) {
        const el = optionEls[i];
        if (!el) continue;
        if (!optionRestores.has(el)) optionRestores.set(el, snapshotAttributes(el, OPTION_ATTRS));
        nextIndex.set(el, i);
        if (!el.id) {
          el.id = generatedIdFor(el, taken);
          taken.add(el.id);
        }
        el.setAttribute("role", "option");
        el.setAttribute("aria-selected", sel !== null && isEqual(items[i], sel) ? "true" : "false");
        const disabled = isDisabled(items[i]);
        if (disabled) el.setAttribute("aria-disabled", "true");
        else el.removeAttribute("aria-disabled");
        if (i === idx && !disabled) activeEl = el;
      }
      // Options that left the list are no longer this widget's to manage.
      for (const [el, restore] of optionRestores) {
        if (nextIndex.has(el)) continue;
        restore();
        optionRestores.delete(el);
        if (lastScrolled === el) lastScrolled = null;
      }
      optionIndex = nextIndex;

      if (openNow && activeEl) {
        trigger.setAttribute("aria-activedescendant", activeEl.id);
        // Keep the keyboard's option visible in a scrolling list. Only when it
        // changes, so an outside value update does not yank the scroll.
        if (activeEl !== lastScrolled) {
          (activeEl as HTMLElement & { scrollIntoView?: (o?: ScrollIntoViewOptions) => void }).scrollIntoView?.({
            block: "nearest",
          });
          lastScrolled = activeEl;
        }
      } else {
        trigger.removeAttribute("aria-activedescendant");
        if (!openNow) lastScrolled = null;
      }
    }, trigger);

    // ── Typeahead (APG): characters typed within 500 ms form one search string.
    // A repeated single letter cycles through the options starting with it.
    let typeBuffer = "";
    let typeTimer: ReturnType<typeof setTimeout> | null = null;
    const typeahead = (char: string): void => {
      typeBuffer += char.toLowerCase();
      if (typeTimer !== null) clearTimeout(typeTimer);
      typeTimer = setTimeout(() => {
        typeBuffer = "";
        typeTimer = null;
      }, 500);
      const items = getItems();
      const n = items.length;
      if (n === 0) return;
      const start = untracked(active);
      const repeated = typeBuffer.length > 1 && [...typeBuffer].every((c) => c === typeBuffer[0]);
      const needle = repeated ? typeBuffer[0] : typeBuffer;
      // A fresh search starts AFTER the active option, so pressing "t" twice
      // moves to the next "t…"; a longer string keeps matching from it.
      const offset = typeBuffer.length === 1 || repeated ? 1 : 0;
      for (let k = 0; k < n; k++) {
        const i = (Math.max(start, 0) + offset + k) % n;
        if (!isDisabled(items[i]) && toStr(items[i]).toLowerCase().startsWith(needle)) {
          setActiveIndex(i);
          return;
        }
      }
    };

    const commitActive = (): void => {
      const item = untracked(activeItem);
      if (item !== null && !isDisabled(item)) select(item);
      else close();
    };

    const move = (delta: number): void => {
      const items = getItems();
      const cur = untracked(active);
      const dir = delta > 0 ? 1 : -1;
      // Clamp to the ends rather than wrapping, as the APG pattern does; a
      // page jump that lands on a disabled option keeps going the same way,
      // then falls back the other way.
      const target = Math.min(items.length - 1, Math.max(0, cur + delta));
      let next = enabledFrom(items, target, dir);
      if (next === -1) next = enabledFrom(items, target, dir === 1 ? -1 : 1);
      if (next !== -1) setActiveIndex(next);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (isWidgetKeyEvent(e) || e.ctrlKey || e.metaKey) return;
      const openNow = untracked(isOpen);
      const key = e.key;
      let handled = true;

      if (!openNow) {
        if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") open();
        else if (key === "Home") open("first");
        else if (key === "End") open("last");
        else if (key.length === 1 && !e.altKey) {
          open();
          typeahead(key);
        } else handled = false;
      } else if (key === "ArrowDown" && !e.altKey) move(1);
      else if (key === "ArrowUp" && e.altKey) commitActive();
      else if (key === "ArrowUp") move(-1);
      else if (key === "Home") setActive(enabledFrom(getItems(), 0, 1));
      else if (key === "End") {
        const items = getItems();
        setActive(enabledFrom(items, items.length - 1, -1));
      } else if (key === "PageDown") move(pageSize);
      else if (key === "PageUp") move(-pageSize);
      else if (key === "Escape") close();
      else if (key === " " && typeBuffer !== "") typeahead(key);
      else if (key === "Enter" || key === " ") commitActive();
      else if (key === "Tab") {
        // Commit and let focus move on: not claimed, not prevented.
        commitActive();
        handled = false;
      } else if (key.length === 1 && !e.altKey) typeahead(key);
      else handled = false;

      if (handled) {
        e.preventDefault();
        claimWidgetKey(e, "selectMenu");
      }
    };

    const onTriggerClick = (): void => toggle();

    // Options are not focusable; without this a press on one would move focus
    // to <body> and fire the trigger's blur before the click lands.
    const onListboxPointerDown = (e: Event): void => e.preventDefault();

    const optionFromEvent = (e: Event): number => {
      let node = e.target as Node | null;
      while (node && node !== listbox) {
        const i = optionIndex.get(node as HTMLElement);
        if (i !== undefined) return i;
        node = node.parentNode;
      }
      return -1;
    };

    const onListboxClick = (e: Event): void => {
      const i = optionFromEvent(e);
      if (i === -1) return;
      const item = getItems()[i];
      if (isDisabled(item)) return;
      select(item);
      trigger.focus();
    };

    const onListboxPointerMove = (e: Event): void => {
      const i = optionFromEvent(e);
      if (i !== -1 && i !== untracked(active)) setActive(i);
    };

    // Outside press: close, keep the selection, leave focus where the user
    // put it (they clicked something else on purpose).
    const onDocPointerDown = (e: Event): void => {
      if (!untracked(isOpen)) return;
      const target = e.target as Node | null;
      if (target && (trigger.contains(target) || listbox.contains(target))) return;
      close();
    };

    // Focus leaving the trigger for anything outside the menu closes it.
    const onTriggerBlur = (e: FocusEvent): void => {
      if (!untracked(isOpen)) return;
      const next = e.relatedTarget as Node | null;
      if (next && listbox.contains(next)) return;
      close();
    };

    trigger.addEventListener("keydown", onKey);
    trigger.addEventListener("click", onTriggerClick);
    trigger.addEventListener("blur", onTriggerBlur);
    listbox.addEventListener("mousedown", onListboxPointerDown);
    listbox.addEventListener("click", onListboxClick);
    listbox.addEventListener("pointermove", onListboxPointerMove);
    const doc = trigger.ownerDocument;
    doc.addEventListener("pointerdown", onDocPointerDown, true);

    let tornDown = false;
    const teardown = (): void => {
      if (tornDown) return;
      tornDown = true;
      if (boundMenus.get(trigger) === teardown) boundMenus.delete(trigger);
      stopBinding();
      trigger.removeEventListener("keydown", onKey);
      trigger.removeEventListener("click", onTriggerClick);
      trigger.removeEventListener("blur", onTriggerBlur);
      listbox.removeEventListener("mousedown", onListboxPointerDown);
      listbox.removeEventListener("click", onListboxClick);
      listbox.removeEventListener("pointermove", onListboxPointerMove);
      doc.removeEventListener("pointerdown", onDocPointerDown, true);
      if (typeTimer !== null) clearTimeout(typeTimer);
      for (const restore of optionRestores.values()) restore();
      optionRestores.clear();
      optionIndex.clear();
      restoreTrigger();
      restoreListbox();
      listbox.hidden = prevHidden;
    };
    boundMenus.set(trigger, teardown);
    return teardown;
  }

  return { value, isOpen, open, close, toggle, active, activeItem, setActive, select, bind };
}
