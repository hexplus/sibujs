import { createId } from "../core/rendering/createId";
import { registerDisposer, unregisterDisposer } from "../core/rendering/dispose";
import { signal } from "../core/signals/signal";
import { batch } from "../reactivity/batch";

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
  /**
   * Reactive value: the selected option values, in selection order. Holds at
   * most one value in single-select mode. Every `data-value` string — including
   * ones containing commas and the empty string — is represented exactly.
   */
  selectedValues: () => readonly string[];
  /**
   * Reactive value: the selected option value (single-select), or the selected
   * values joined with `","` (multiple).
   *
   * @deprecated In multiple mode the CSV view is lossy — a value containing a
   * comma cannot be told apart from two values. Use {@link selectedValues}.
   */
  selectedValue: () => string | null;
  /** Stable id that can be used as `aria-activedescendant` on the trigger. */
  activeDescendantId: () => string | null;
  /**
   * Reconcile options added or removed since the last change: new options get a
   * stable id and `aria-selected`, and a removed active option stops being the
   * active descendant. Happens automatically (on DOM mutation and before every
   * interaction); call it to reconcile synchronously.
   */
  refresh: () => void;
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
  // The collection is the source of truth; `selectedValue` is only a
  // compatibility view written alongside it and never parsed back.
  const [selectedValues, setSelectedValues] = signal<readonly string[]>([]);
  const [selectedValue, setSelectedValue] = signal<string | null>(null);
  const [activeDescendantId, setActiveDescendantId] = signal<string | null>(null);
  // Plain mirror of `activeValue` for reconciliation, which must not track it.
  let activeValueRef: string | null = null;

  // The current selection, mirrored from the signal so reconciliation never
  // reads (and subscribes to) it.
  let currentSelection: readonly string[] = [];

  // Give every option a stable id so aria-activedescendant can point at it,
  // and aria-selected so options expose selection state (ARIA expects it on
  // every role="option"). Stamping only once at creation left options inserted
  // later without an id — navigation then set an empty active descendant — and
  // without selection state. So options are reconciled whenever they may have
  // changed: on DOM mutation, and synchronously before every interaction.
  function reconcileOptions(): HTMLElement[] {
    const opts = Array.from(container.querySelectorAll<HTMLElement>(optionSelector));
    const selectedSet = new Set(currentSelection);
    let activeStillPresent = false;
    const active = activeValueRef;
    for (const opt of opts) {
      if (!opt.id) opt.id = createId("listbox-option");
      const ov = opt.dataset.value;
      // Only options without selection state are initialized; select() keeps
      // the rest in sync, and markup-supplied state is not overwritten.
      if (!opt.hasAttribute("aria-selected")) {
        opt.setAttribute("aria-selected", ov !== undefined && selectedSet.has(ov) ? "true" : "false");
      }
      if (active !== null && ov === active) activeStillPresent = true;
    }
    // The active option was removed: it can no longer be the active descendant.
    if (active !== null && !activeStillPresent) setActive(null, opts);
    return opts;
  }

  function getOptions(): HTMLElement[] {
    return reconcileOptions();
  }

  // An option exposed as unavailable is not actionable: navigation skips it and
  // selection refuses it. Read live, so a changed aria-disabled takes effect.
  function isDisabled(opt: Element): boolean {
    return opt.getAttribute("aria-disabled") === "true" || opt.hasAttribute("disabled");
  }

  function enabledOptions(): HTMLElement[] {
    return getOptions().filter((opt) => !isDisabled(opt) && opt.dataset.value !== undefined);
  }

  function optionByValue(value: string): HTMLElement | undefined {
    return getOptions().find((opt) => opt.dataset.value === value);
  }

  function setActive(value: string | null, known?: HTMLElement[]): void {
    activeValueRef = value;
    setActiveValue(value);
    const opts = known ?? getOptions();
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
    const target = optionByValue(value);
    if (!target || isDisabled(target)) return;
    // Snapshot the previous selection once and compute the next collection from
    // it, so DOM reconciliation never reads the signal back. Multiple selection used to live in a CSV string re-split on every toggle,
    // which merged "a,b" with "a" + "b" and dropped "" — so the collection, not
    // the string, is what toggling and ARIA reconciliation work from.
    const previous = selectedValues();
    let next: string[];
    if (multiple) {
      next = previous.includes(value) ? previous.filter((v) => v !== value) : [...previous, value];
    } else {
      next = [value];
    }
    currentSelection = next;
    batch(() => {
      setSelectedValues(next);
      setSelectedValue(multiple ? next.join(",") : value);
    });
    options.onSelect?.(value);

    // Reflect `aria-selected` on each option using the computed next set. An
    // option without `data-value` is never selectable, so it must not match "".
    const nextSelectedSet = new Set(next);
    const opts = getOptions();
    for (const opt of opts) {
      const ov = opt.dataset.value;
      opt.setAttribute("aria-selected", ov !== undefined && nextSelectedSet.has(ov) ? "true" : "false");
    }
  }

  function moveActive(delta: number): void {
    const opts = enabledOptions();
    if (opts.length === 0) return;
    const currentIdx = opts.findIndex((o) => o.dataset.value === activeValueRef);
    let next = currentIdx === -1 ? (delta > 0 ? 0 : opts.length - 1) : currentIdx + delta;
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
        const opts = enabledOptions();
        if (opts.length > 0) setActive(opts[0].dataset.value ?? null);
        break;
      }
      case "End": {
        e.preventDefault();
        const opts = enabledOptions();
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
    if (!target || !container.contains(target) || isDisabled(target)) return;
    const value = target.dataset.value ?? null;
    if (value !== null) {
      setActive(value);
      select(value);
    }
  }

  container.addEventListener("keydown", onKeyDown);
  container.addEventListener("click", onClick);

  reconcileOptions();
  // Reconcile options inserted or removed without any interaction, so ARIA
  // state is valid for assistive technology before the user navigates.
  let observer: MutationObserver | null = null;
  if (typeof MutationObserver !== "undefined") {
    observer = new MutationObserver(() => {
      if (!disposed) reconcileOptions();
    });
    observer.observe(container, { childList: true, subtree: true });
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // Drop the node-level registration on a manual dispose so re-creating a
    // listbox on a long-lived container does not accumulate dead closures. A
    // no-op when dispose(node) is the caller — its entry is already removed.
    unregisterDisposer(container, dispose);
    observer?.disconnect();
    observer = null;
    container.removeEventListener("keydown", onKeyDown);
    container.removeEventListener("click", onClick);
  }

  registerDisposer(container, dispose);

  return { activeValue, selectedValues, selectedValue, activeDescendantId, refresh: reconcileOptions, dispose };
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
