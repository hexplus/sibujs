import { createId, idSegment } from "../core/rendering/createId";
import { derived } from "../core/signals/derived";
import { signal } from "../core/signals/signal";
import { domBinding } from "../reactivity/domBinding";
import { snapshotAttributes } from "./attributeSnapshot";

// First trigger of an accordion identifies the binding instance for
// idempotency — calling bind() twice on the same set returns the prior
// teardown rather than stacking listeners + effects.
const boundAccordions = new WeakMap<HTMLElement, () => void>();

export interface AccordionOptions {
  items: Array<{ id: string; label: string }>;
  multiple?: boolean;
  defaultExpanded?: string[];
}

export interface AccordionAriaBinding {
  /** WAI-ARIA Accordion pattern — wires `aria-expanded`/`aria-controls`,
   *  Enter/Space toggle, and panel `role=region`. Returns dispose.
   *  Pass `root` (any stable container element) to anchor the WeakMap
   *  idempotency key — without it, double-bind detection falls back to
   *  the first trigger and breaks if items re-render. */
  bind: (els: {
    root?: HTMLElement;
    triggers: Record<string, HTMLElement>;
    panels: Record<string, HTMLElement>;
  }) => () => void;
}

export function accordion(options: AccordionOptions): {
  items: () => Array<{ id: string; label: string; isExpanded: boolean }>;
  toggle: (id: string) => void;
  expand: (id: string) => void;
  collapse: (id: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
  isExpanded: (id: string) => boolean;
  bind: AccordionAriaBinding["bind"];
} {
  const { items: itemDefs, multiple = false, defaultExpanded = [] } = options;

  // Seed state through the same invariants expand() enforces: unknown ids are
  // dropped, and single mode keeps only the first valid default. Seeding from
  // `defaultExpanded` verbatim let single mode start with several panels open.
  const knownIds = new Set(itemDefs.map((item) => item.id));
  const validDefaults = defaultExpanded.filter((id) => knownIds.has(id));
  const initialExpanded = multiple ? validDefaults : validDefaults.slice(0, 1);

  const [expandedIds, setExpandedIds] = signal<Set<string>>(new Set(initialExpanded));

  const items = derived(() =>
    itemDefs.map((item) => ({
      ...item,
      isExpanded: expandedIds().has(item.id),
    })),
  );

  function expand(id: string): void {
    if (!itemDefs.some((item) => item.id === id)) return;

    if (multiple) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    } else {
      // Single mode: only this item is expanded
      setExpandedIds(new Set([id]));
    }
  }

  function collapse(id: string): void {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function toggle(id: string): void {
    if (expandedIds().has(id)) {
      collapse(id);
    } else {
      expand(id);
    }
  }

  function expandAll(): void {
    if (multiple) {
      setExpandedIds(new Set(itemDefs.map((item) => item.id)));
    }
  }

  function collapseAll(): void {
    setExpandedIds(new Set());
  }

  /** Check if a specific item is expanded (reactive getter — safe inside each()) */
  function isExpanded(id: string): boolean {
    return expandedIds().has(id);
  }

  function bind(els: {
    root?: HTMLElement;
    triggers: Record<string, HTMLElement>;
    panels: Record<string, HTMLElement>;
  }): () => void {
    // Prefer caller-supplied `root` for the idempotency key; fall back to
    // first trigger only when no root was given (legacy callers).
    const idempotencyKey: HTMLElement | undefined =
      els.root ?? (itemDefs.length > 0 ? els.triggers[itemDefs[0].id] : undefined);
    if (idempotencyKey) {
      const existing = boundAccordions.get(idempotencyKey);
      if (existing) return existing;
    }
    // Snapshot every attribute the binding may touch — including aria-expanded
    // and hidden, which the reactive binding owns — so teardown restores author
    // markup exactly instead of deleting pre-existing ARIA state.
    const restore: Array<() => void> = [];
    // One unique prefix per binding (see Tabs): ids from the item id alone
    // collided across accordions and broke on whitespace. Author ids are kept.
    const idPrefix = createId("sibu-accordion");
    for (const item of itemDefs) {
      const trig = els.triggers[item.id];
      const panel = els.panels[item.id];
      if (!trig) continue;
      restore.push(snapshotAttributes(trig, ["id", "aria-controls", "aria-expanded"]));
      if (!trig.id) trig.id = `${idPrefix}-trigger-${idSegment(item.id)}`;
      if (panel) {
        restore.push(snapshotAttributes(panel, ["role", "id", "aria-labelledby", "hidden"]));
        panel.setAttribute("role", "region");
        if (!panel.id) panel.id = `${idPrefix}-panel-${idSegment(item.id)}`;
        panel.setAttribute("aria-labelledby", trig.id);
        trig.setAttribute("aria-controls", panel.id);
      }
    }

    const fxTeardown = domBinding(() => {
      const ids = expandedIds();
      for (const item of itemDefs) {
        const trig = els.triggers[item.id];
        const panel = els.panels[item.id];
        if (!trig) continue;
        const expanded = ids.has(item.id);
        trig.setAttribute("aria-expanded", expanded ? "true" : "false");
        if (panel) panel.hidden = !expanded;
      }
    }, idempotencyKey);

    const handlers: Array<{ el: HTMLElement; click: (e: Event) => void; key: (e: KeyboardEvent) => void }> = [];
    for (const item of itemDefs) {
      const trig = els.triggers[item.id];
      if (!trig) continue;
      const click = () => toggle(item.id);
      const key = (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle(item.id);
        }
      };
      trig.addEventListener("click", click);
      trig.addEventListener("keydown", key);
      handlers.push({ el: trig, click, key });
    }

    let tornDown = false;
    const teardown = () => {
      if (tornDown) return;
      tornDown = true;
      if (idempotencyKey) boundAccordions.delete(idempotencyKey);
      fxTeardown();
      for (const { el, click, key } of handlers) {
        el.removeEventListener("click", click);
        el.removeEventListener("keydown", key);
      }
      for (const r of restore) r();
    };
    if (idempotencyKey) boundAccordions.set(idempotencyKey, teardown);
    return teardown;
  }

  return {
    items,
    toggle,
    expand,
    collapse,
    expandAll,
    collapseAll,
    /** Reactive check — use inside class/nodes bindings for per-item reactivity */
    isExpanded,
    bind,
  };
}
