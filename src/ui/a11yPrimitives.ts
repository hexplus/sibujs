import { createId } from "../core/rendering/createId";
import { registerDisposer } from "../core/rendering/dispose";
import { signal } from "../core/signals/signal";

// ============================================================================
// ACCESSIBILITY PRIMITIVES
// ============================================================================
//
// These are headless a11y primitives — zero visual styling, just the
// ARIA attributes + keyboard wiring needed to build an accessible
// listbox, dialog, or focus-managed group. They mirror what
// react-aria / radix-primitives offer but in plain-function form, and
// they integrate with the existing `createId()` helper for stable id
// pairing across server/client.

// ─── focusManager ─────────────────────────────────────────────────────────

export interface FocusManagerOptions {
  /** CSS selector for focusable descendants. Default matches common form/link controls. */
  selector?: string;
  /** Wrap focus from last→first and first→last. Default `true`. */
  loop?: boolean;
}

export interface FocusManagerHandle {
  /** Move focus to the first focusable descendant. */
  focusFirst: () => void;
  /** Move focus to the last focusable descendant. */
  focusLast: () => void;
  /** Move focus to the next focusable descendant relative to `document.activeElement`. */
  focusNext: () => void;
  /** Move focus to the previous focusable descendant relative to `document.activeElement`. */
  focusPrev: () => void;
  /** Return the currently focusable descendants, in order. */
  items: () => HTMLElement[];
}

const DEFAULT_FOCUS_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Build a focus manager scoped to a container. The manager offers
 * `focusFirst` / `focusLast` / `focusNext` / `focusPrev` helpers that
 * walk the focusable descendants in DOM order. It is the building
 * block for custom listboxes, toolbars, and menus.
 *
 * This is a DOM-read utility — the item list is fetched fresh on every
 * call so dynamic content is handled automatically.
 */
export function createFocusManager(container: HTMLElement, options: FocusManagerOptions = {}): FocusManagerHandle {
  const selector = options.selector ?? DEFAULT_FOCUS_SELECTOR;
  const loop = options.loop ?? true;

  function items(): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(selector));
  }

  function focusFirst(): void {
    const all = items();
    if (all.length > 0) all[0].focus();
  }

  function focusLast(): void {
    const all = items();
    if (all.length > 0) all[all.length - 1].focus();
  }

  function focusNext(): void {
    const all = items();
    if (all.length === 0) return;
    const idx = all.indexOf(document.activeElement as HTMLElement);
    if (idx === -1) {
      all[0].focus();
      return;
    }
    const next = idx + 1;
    if (next >= all.length) {
      if (loop) all[0].focus();
      return;
    }
    all[next].focus();
  }

  function focusPrev(): void {
    const all = items();
    if (all.length === 0) return;
    const idx = all.indexOf(document.activeElement as HTMLElement);
    if (idx === -1) {
      all[all.length - 1].focus();
      return;
    }
    const prev = idx - 1;
    if (prev < 0) {
      if (loop) all[all.length - 1].focus();
      return;
    }
    all[prev].focus();
  }

  return { focusFirst, focusLast, focusNext, focusPrev, items };
}

// ─── listbox ──────────────────────────────────────────────────────────────

export interface ListboxOptions {
  /** Whether the listbox is multi-select. Default `false`. */
  multiple?: boolean;
  /** CSS selector for option elements. Default `[role="option"]`. */
  optionSelector?: string;
  /** Called when the user commits a selection. */
  onSelect?: (value: string) => void;
}

export interface ListboxHandle {
  /** Reactive value: the currently-active (highlighted) option value. */
  activeValue: () => string | null;
  /** Reactive value: the currently-selected option value (single-select) or CSV (multiple). */
  selectedValue: () => string | null;
  /** Stable id that can be used as `aria-activedescendant` on the trigger. */
  activeDescendantId: () => string | null;
  /** Cleanup: removes listeners. */
  dispose: () => void;
}

/**
 * Build an ARIA listbox on top of an existing container element. The
 * listbox wires:
 *   - `role="listbox"` + `aria-multiselectable` on the container
 *   - keyboard navigation (Arrow keys, Home, End, Enter, Space)
 *   - `aria-activedescendant` tracking
 *   - option highlight via `data-highlighted`
 *
 * Each option must expose a `data-value` attribute. Options get a
 * stable `id` on mount so the container's `aria-activedescendant`
 * can point at the active one.
 *
 * @example
 * ```ts
 * const container = ul([
 *   li({ role: "option", "data-value": "a" }, "Apple"),
 *   li({ role: "option", "data-value": "b" }, "Banana"),
 * ]) as HTMLElement;
 *
 * const lb = createListbox(container, { onSelect: v => console.log(v) });
 * ```
 */
export function createListbox(container: HTMLElement, options: ListboxOptions = {}): ListboxHandle {
  const multiple = options.multiple ?? false;
  const optionSelector = options.optionSelector ?? '[role="option"]';

  container.setAttribute("role", "listbox");
  if (multiple) container.setAttribute("aria-multiselectable", "true");
  if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "0");

  const [activeValue, setActiveValue] = signal<string | null>(null);
  const [selectedValue, setSelectedValue] = signal<string | null>(null);
  const [activeDescendantId, setActiveDescendantId] = signal<string | null>(null);

  // Stamp every option with a stable id so aria-activedescendant can point at it.
  function stampIds(): void {
    const opts = Array.from(container.querySelectorAll<HTMLElement>(optionSelector));
    for (const opt of opts) {
      if (!opt.id) opt.id = createId("listbox-option");
    }
  }
  stampIds();

  function getOptions(): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(optionSelector));
  }

  function setActive(value: string | null): void {
    setActiveValue(value);
    const opts = getOptions();
    for (const opt of opts) {
      if (opt.dataset.value === value) {
        opt.setAttribute("data-highlighted", "");
        setActiveDescendantId(opt.id || null);
        container.setAttribute("aria-activedescendant", opt.id || "");
      } else {
        opt.removeAttribute("data-highlighted");
      }
    }
    if (value === null) {
      setActiveDescendantId(null);
      container.removeAttribute("aria-activedescendant");
    }
  }

  function select(value: string): void {
    // Snapshot the previous selection once — reading the signal a second
    // time after `setSelectedValue()` would mix DOM reconciliation into the
    // signal read path and can race if any subscribers mutate state.
    const previous = selectedValue();
    let nextSelectedSet: Set<string>;
    if (multiple) {
      nextSelectedSet = new Set((previous ?? "").split(",").filter(Boolean));
      if (nextSelectedSet.has(value)) nextSelectedSet.delete(value);
      else nextSelectedSet.add(value);
      setSelectedValue(Array.from(nextSelectedSet).join(","));
    } else {
      nextSelectedSet = new Set([value]);
      setSelectedValue(value);
    }
    options.onSelect?.(value);

    // Reflect `aria-selected` on each option using the computed next set.
    const opts = getOptions();
    for (const opt of opts) {
      const ov = opt.dataset.value ?? "";
      opt.setAttribute("aria-selected", nextSelectedSet.has(ov) ? "true" : "false");
    }
  }

  function moveActive(delta: number): void {
    const opts = getOptions();
    if (opts.length === 0) return;
    const currentIdx = opts.findIndex((o) => o.dataset.value === activeValue());
    let next = currentIdx + delta;
    if (next < 0) next = opts.length - 1;
    if (next >= opts.length) next = 0;
    const nextValue = opts[next].dataset.value ?? null;
    setActive(nextValue);
    // `scrollIntoView` is not implemented in jsdom and may be missing on
    // other headless runtimes — keep keyboard nav working either way.
    if (typeof opts[next].scrollIntoView === "function") {
      opts[next].scrollIntoView({ block: "nearest" });
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        break;
      case "Home": {
        e.preventDefault();
        const opts = getOptions();
        if (opts.length > 0) setActive(opts[0].dataset.value ?? null);
        break;
      }
      case "End": {
        e.preventDefault();
        const opts = getOptions();
        if (opts.length > 0) setActive(opts[opts.length - 1].dataset.value ?? null);
        break;
      }
      case "Enter":
      case " ": {
        e.preventDefault();
        const active = activeValue();
        if (active !== null) select(active);
        break;
      }
    }
  }

  function onClick(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest(optionSelector) as HTMLElement | null;
    if (!target || !container.contains(target)) return;
    const value = target.dataset.value ?? null;
    if (value !== null) {
      setActive(value);
      select(value);
    }
  }

  container.addEventListener("keydown", onKeyDown);
  container.addEventListener("click", onClick);

  function dispose(): void {
    container.removeEventListener("keydown", onKeyDown);
    container.removeEventListener("click", onClick);
  }

  registerDisposer(container, dispose);

  return { activeValue, selectedValue, activeDescendantId, dispose };
}

// ─── dialogAria ───────────────────────────────────────────────────────────

export interface DialogAriaOptions {
  /** Labelled-by id — the dialog title's id. */
  labelledBy?: string;
  /** Described-by id — the dialog description's id. */
  describedBy?: string;
  /** Modal dialog (true) or alertdialog (false for "alert"). Default `true`. */
  modal?: boolean;
  /** Use `role="alertdialog"` instead of `role="dialog"`. */
  alert?: boolean;
}

export interface DialogAriaHandle {
  /** Auto-generated id that should be put on the title element. */
  titleId: string;
  /** Auto-generated id that should be put on the description element. */
  descriptionId: string;
}

/**
 * Apply the ARIA attributes needed for an accessible dialog to an
 * existing element. Returns stable ids that the caller can pass to the
 * title and description children so `aria-labelledby` / `aria-describedby`
 * resolve correctly.
 *
 * Does NOT handle focus trapping — use `FocusTrap` or `createFocusManager`
 * for that. Does NOT handle escape-to-close — wire that in the caller.
 * The primitive is intentionally tight: it only owns the ARIA surface.
 *
 * @example
 * ```ts
 * const dlg = document.createElement("div");
 * const aria = createDialogAria(dlg, { alert: false });
 * dlg.append(
 *   h2({ id: aria.titleId }, "Delete?"),
 *   p({ id: aria.descriptionId }, "This cannot be undone."),
 * );
 * ```
 */
export function createDialogAria(element: HTMLElement, options: DialogAriaOptions = {}): DialogAriaHandle {
  const titleId = options.labelledBy ?? createId("dialog-title");
  const descriptionId = options.describedBy ?? createId("dialog-desc");

  element.setAttribute("role", options.alert ? "alertdialog" : "dialog");
  if (options.modal ?? true) element.setAttribute("aria-modal", "true");
  element.setAttribute("aria-labelledby", titleId);
  element.setAttribute("aria-describedby", descriptionId);
  if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");

  return { titleId, descriptionId };
}
