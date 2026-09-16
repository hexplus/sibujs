import { createId, idSegment } from "../core/rendering/createId";
import { derived } from "../core/signals/derived";
import { signal } from "../core/signals/signal";
import { domBinding } from "../reactivity/domBinding";
import { snapshotAttributes } from "./attributeSnapshot";

const boundTablists = new WeakMap<HTMLElement, () => void>();

export interface TabsOptions {
  tabs: Array<{ id: string; label: string; disabled?: boolean }>;
  defaultTab?: string;
}

export interface TabsAriaBinding {
  /** WAI-ARIA Tabs pattern — wires `role`/`aria-*` and arrow/Home/End keys
   *  to the provided tablist + per-tab elements. Returns dispose. */
  bind: (els: {
    tablist: HTMLElement;
    tabs: Record<string, HTMLElement>;
    panels?: Record<string, HTMLElement>;
  }) => () => void;
}

export function tabs(options: TabsOptions): {
  activeTab: () => string;
  setActiveTab: (id: string) => void;
  tabs: () => Array<{ id: string; label: string; disabled?: boolean; isActive: boolean }>;
  nextTab: () => void;
  prevTab: () => void;
  isActive: (id: string) => boolean;
  bind: TabsAriaBinding["bind"];
} {
  const { tabs: tabDefs, defaultTab } = options;

  // The active tab is never disabled (setActiveTab() and keyboard navigation
  // enforce that), so the initial state must not be either. `defaultTab` is
  // used only when it names an enabled tab; otherwise the first enabled tab is
  // active, and when every tab is disabled no tab is active ("").
  const firstEnabled = tabDefs.find((t) => !t.disabled)?.id ?? "";
  const initialTab =
    defaultTab !== undefined && tabDefs.some((t) => t.id === defaultTab && !t.disabled) ? defaultTab : firstEnabled;

  const [activeTab, setActiveTabState] = signal<string>(initialTab);

  function setActiveTab(id: string): void {
    const tab = tabDefs.find((t) => t.id === id);
    if (tab && !tab.disabled) {
      setActiveTabState(id);
    }
  }

  const tabs = derived(() =>
    tabDefs.map((t) => ({
      ...t,
      isActive: t.id === activeTab(),
    })),
  );

  function findCurrentIndex(): number {
    return tabDefs.findIndex((t) => t.id === activeTab());
  }

  function nextTab(): void {
    const currentIdx = findCurrentIndex();
    const len = tabDefs.length;
    if (len === 0) return;

    // Search forward, wrapping around, skipping disabled tabs
    for (let i = 1; i <= len; i++) {
      const candidate = tabDefs[(currentIdx + i) % len];
      if (!candidate.disabled) {
        setActiveTabState(candidate.id);
        return;
      }
    }
  }

  function prevTab(): void {
    const currentIdx = findCurrentIndex();
    const len = tabDefs.length;
    if (len === 0) return;

    // Search backward, wrapping around, skipping disabled tabs
    for (let i = 1; i <= len; i++) {
      const candidate = tabDefs[(currentIdx - i + len) % len];
      if (!candidate.disabled) {
        setActiveTabState(candidate.id);
        return;
      }
    }
  }

  /** Check if a specific tab is active (reactive getter — safe inside each()) */
  function isActive(id: string): boolean {
    return activeTab() === id;
  }

  function bind(els: {
    tablist: HTMLElement;
    tabs: Record<string, HTMLElement>;
    panels?: Record<string, HTMLElement>;
  }): () => void {
    const existing = boundTablists.get(els.tablist);
    if (existing) return existing;
    // Snapshot every attribute the binding may touch — including the ones the
    // reactive binding owns (aria-selected, tabindex, hidden) — so teardown puts
    // author markup back exactly instead of deleting pre-existing ARIA state.
    const restore: Array<() => void> = [snapshotAttributes(els.tablist, ["role"])];
    els.tablist.setAttribute("role", "tablist");
    // One unique prefix per binding. Ids derived from the item id alone collided
    // across widgets with the same item ids (aria-controls then pointed at another
    // widget's panel), and item ids with whitespace produced multi-token ARIA
    // references. Author-provided element ids are kept and referenced as-is.
    const idPrefix = createId("sibu-tabs");
    for (const def of tabDefs) {
      const tabEl = els.tabs[def.id];
      if (!tabEl) continue;
      restore.push(
        snapshotAttributes(tabEl, ["role", "id", "aria-disabled", "aria-controls", "aria-selected", "tabindex"]),
      );
      tabEl.setAttribute("role", "tab");
      if (!tabEl.id) tabEl.id = `${idPrefix}-tab-${idSegment(def.id)}`;
      // Reconcile in both directions: the definition decides interactivity, so a
      // stale aria-disabled="true" on an enabled tab must not stay exposed.
      if (def.disabled) tabEl.setAttribute("aria-disabled", "true");
      else tabEl.removeAttribute("aria-disabled");
      const panelEl = els.panels?.[def.id];
      if (panelEl) {
        restore.push(snapshotAttributes(panelEl, ["role", "id", "aria-labelledby", "hidden"]));
        panelEl.setAttribute("role", "tabpanel");
        if (!panelEl.id) panelEl.id = `${idPrefix}-panel-${idSegment(def.id)}`;
        panelEl.setAttribute("aria-labelledby", tabEl.id);
        tabEl.setAttribute("aria-controls", panelEl.id);
      }
    }

    // Roving tabindex + aria-selected reflect the active tab reactively.
    const fxTeardown = domBinding(() => {
      const active = activeTab();
      for (const def of tabDefs) {
        const tabEl = els.tabs[def.id];
        if (!tabEl) continue;
        const isAct = def.id === active;
        tabEl.setAttribute("aria-selected", isAct ? "true" : "false");
        tabEl.tabIndex = isAct ? 0 : -1;
        const panelEl = els.panels?.[def.id];
        if (panelEl) panelEl.hidden = !isAct;
      }
    }, els.tablist);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        nextTab();
        els.tabs[activeTab()]?.focus();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        prevTab();
        els.tabs[activeTab()]?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        const first = tabDefs.find((t) => !t.disabled);
        if (first) {
          setActiveTabState(first.id);
          els.tabs[first.id]?.focus();
        }
      } else if (e.key === "End") {
        e.preventDefault();
        for (let i = tabDefs.length - 1; i >= 0; i--) {
          if (!tabDefs[i].disabled) {
            setActiveTabState(tabDefs[i].id);
            els.tabs[tabDefs[i].id]?.focus();
            break;
          }
        }
      }
    };
    els.tablist.addEventListener("keydown", onKey);

    const clickHandlers: Array<{ el: HTMLElement; fn: (e: Event) => void }> = [];
    for (const def of tabDefs) {
      const tabEl = els.tabs[def.id];
      if (!tabEl) continue;
      const fn = () => setActiveTab(def.id);
      tabEl.addEventListener("click", fn);
      clickHandlers.push({ el: tabEl, fn });
    }

    let tornDown = false;
    const teardown = () => {
      if (tornDown) return;
      tornDown = true;
      boundTablists.delete(els.tablist);
      fxTeardown();
      els.tablist.removeEventListener("keydown", onKey);
      for (const { el, fn } of clickHandlers) el.removeEventListener("click", fn);
      for (const r of restore) r();
    };
    boundTablists.set(els.tablist, teardown);
    return teardown;
  }

  return {
    activeTab,
    setActiveTab,
    tabs,
    nextTab,
    prevTab,
    /** Reactive check — use inside class/nodes bindings for per-tab reactivity */
    isActive,
    bind,
  };
}
