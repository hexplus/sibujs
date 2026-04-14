import { derived } from "../core/signals/derived";
import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";

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

  // Default to the first non-disabled tab, or the explicit default
  const initialTab = defaultTab ?? tabDefs.find((t) => !t.disabled)?.id ?? tabDefs[0]?.id ?? "";

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
    // Snapshot prior attribute state so teardown can restore.
    const restore: Array<() => void> = [];
    const prevTablistRole = els.tablist.getAttribute("role");
    els.tablist.setAttribute("role", "tablist");
    restore.push(() => {
      if (prevTablistRole === null) els.tablist.removeAttribute("role");
      else els.tablist.setAttribute("role", prevTablistRole);
    });
    for (const def of tabDefs) {
      const tabEl = els.tabs[def.id];
      if (!tabEl) continue;
      const prevRole = tabEl.getAttribute("role");
      const prevId = tabEl.id;
      const prevDisabled = tabEl.getAttribute("aria-disabled");
      const prevControls = tabEl.getAttribute("aria-controls");
      tabEl.setAttribute("role", "tab");
      tabEl.setAttribute("id", `sibu-tab-${def.id}`);
      if (def.disabled) tabEl.setAttribute("aria-disabled", "true");
      const panelEl = els.panels?.[def.id];
      let prevPanelRole: string | null = null;
      let prevPanelId = "";
      let prevPanelLabelledBy: string | null = null;
      if (panelEl) {
        prevPanelRole = panelEl.getAttribute("role");
        prevPanelId = panelEl.id;
        prevPanelLabelledBy = panelEl.getAttribute("aria-labelledby");
        panelEl.setAttribute("role", "tabpanel");
        panelEl.setAttribute("id", `sibu-tabpanel-${def.id}`);
        panelEl.setAttribute("aria-labelledby", `sibu-tab-${def.id}`);
        tabEl.setAttribute("aria-controls", `sibu-tabpanel-${def.id}`);
      }
      restore.push(() => {
        if (prevRole === null) tabEl.removeAttribute("role");
        else tabEl.setAttribute("role", prevRole);
        if (prevId === "") tabEl.removeAttribute("id");
        else tabEl.id = prevId;
        if (prevDisabled === null) tabEl.removeAttribute("aria-disabled");
        else tabEl.setAttribute("aria-disabled", prevDisabled);
        if (prevControls === null) tabEl.removeAttribute("aria-controls");
        else tabEl.setAttribute("aria-controls", prevControls);
        tabEl.removeAttribute("aria-selected");
        tabEl.removeAttribute("tabindex");
        if (panelEl) {
          if (prevPanelRole === null) panelEl.removeAttribute("role");
          else panelEl.setAttribute("role", prevPanelRole);
          if (prevPanelId === "") panelEl.removeAttribute("id");
          else panelEl.id = prevPanelId;
          if (prevPanelLabelledBy === null) panelEl.removeAttribute("aria-labelledby");
          else panelEl.setAttribute("aria-labelledby", prevPanelLabelledBy);
        }
      });
    }

    // Roving tabindex + aria-selected reflect the active tab reactively.
    const fxTeardown = effect(() => {
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
    });

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

    const teardown = () => {
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
