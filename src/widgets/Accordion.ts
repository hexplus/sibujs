import { derived } from "../core/signals/derived";
import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";

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
  // (no-op — kept structure)
  const { items: itemDefs, multiple = false, defaultExpanded = [] } = options;

  const [expandedIds, setExpandedIds] = signal<Set<string>>(new Set(defaultExpanded));

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
    const restore: Array<() => void> = [];
    for (const item of itemDefs) {
      const trig = els.triggers[item.id];
      const panel = els.panels[item.id];
      if (!trig) continue;
      const prevTrigId = trig.id;
      const prevTrigControls = trig.getAttribute("aria-controls");
      trig.id = `sibu-accordion-trigger-${item.id}`;
      let prevPanelRole: string | null = null;
      let prevPanelId = "";
      let prevPanelLabelledBy: string | null = null;
      if (panel) {
        prevPanelRole = panel.getAttribute("role");
        prevPanelId = panel.id;
        prevPanelLabelledBy = panel.getAttribute("aria-labelledby");
        panel.setAttribute("role", "region");
        panel.id = `sibu-accordion-panel-${item.id}`;
        panel.setAttribute("aria-labelledby", trig.id);
        trig.setAttribute("aria-controls", panel.id);
      }
      restore.push(() => {
        if (prevTrigId === "") trig.removeAttribute("id");
        else trig.id = prevTrigId;
        if (prevTrigControls === null) trig.removeAttribute("aria-controls");
        else trig.setAttribute("aria-controls", prevTrigControls);
        trig.removeAttribute("aria-expanded");
        if (panel) {
          if (prevPanelRole === null) panel.removeAttribute("role");
          else panel.setAttribute("role", prevPanelRole);
          if (prevPanelId === "") panel.removeAttribute("id");
          else panel.id = prevPanelId;
          if (prevPanelLabelledBy === null) panel.removeAttribute("aria-labelledby");
          else panel.setAttribute("aria-labelledby", prevPanelLabelledBy);
        }
      });
    }

    const fxTeardown = effect(() => {
      const ids = expandedIds();
      for (const item of itemDefs) {
        const trig = els.triggers[item.id];
        const panel = els.panels[item.id];
        if (!trig) continue;
        const expanded = ids.has(item.id);
        trig.setAttribute("aria-expanded", expanded ? "true" : "false");
        if (panel) panel.hidden = !expanded;
      }
    });

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

    const teardown = () => {
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
