/**
 * Sibu DevTools Bridge
 *
 * Architecture (browser-extension bus style):
 *
 *   Sibu App                    Chrome Extension
 *   ┌──────────┐               ┌──────────────┐
 *   │ signal  │──emit──▶│    │  Content      │
 *   │ derived │        │    │  Script       │
 *   │ effect  │        ▼    │   │            │
 *   │ mount     │   __SIBU_   │   ▼            │
 *   └──────────┘   DEVTOOLS_  │  Background   │
 *                  GLOBAL_    │   │            │
 *                  HOOK__     │   ▼            │
 *                    │        │  DevTools      │
 *                    │        │  Panel         │
 *                    ▼        └──────────────┘
 *                 Bridge
 *              (postMessage)
 *
 * The hook is injected by the content script BEFORE the app loads.
 * When initDevTools() is called, the bridge connects to the existing hook
 * or creates one. Events are buffered until the panel connects.
 */

import { isDev } from "../core/dev";
import { signal as _sbSignal } from "../core/signals/signal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DevToolsEvent =
  | { type: "state-change"; component: string; key: string; oldValue: unknown; newValue: unknown; timestamp: number }
  | { type: "mount"; component: string; element: HTMLElement; timestamp: number }
  | { type: "unmount"; component: string; timestamp: number }
  | { type: "render"; component: string; duration: number; timestamp: number }
  | { type: "error"; component: string; error: Error; timestamp: number };

interface DevToolsConfig {
  maxEvents?: number;
  enabled?: boolean;
  maxSignals?: number;
}

interface ComponentEntry {
  element: HTMLElement;
  state?: Record<string, unknown>;
}

/** A tracked reactive node in the devtools tree */
interface DevNode {
  id: number;
  type: "signal" | "computed" | "effect";
  name: string;
  ref: any;
  getter?: () => any;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Global Hook
// ---------------------------------------------------------------------------

interface SibuGlobalHook {
  /** Register an event listener */
  on: (event: string, fn: (...args: unknown[]) => void) => void;
  /** Remove an event listener */
  off: (event: string, fn: (...args: unknown[]) => void) => void;
  /** Emit an event */
  emit: (event: string, payload: unknown) => void;
  /** All registered nodes */
  nodes: Map<number, DevNode>;
  /** All registered components */
  components: Map<string, ComponentEntry>;
  /** Buffered events */
  events: Array<{ event: string; payload: unknown; ts: number }>;
  /** Whether the panel is connected */
  connected: boolean;
  /** Sibu version */
  sibuVersion: string;
}

function createGlobalHook(): SibuGlobalHook {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const events: Array<{ event: string; payload: unknown; ts: number }> = [];
  const nodes = new Map<number, DevNode>();
  const components = new Map<string, ComponentEntry>();

  return {
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    emit(event, payload) {
      // Buffer for late-connecting panels
      events.push({ event, payload, ts: Date.now() });
      if (events.length > 2000) events.splice(0, events.length - 2000);
      // Notify listeners
      const set = listeners.get(event);
      if (set)
        for (const fn of set)
          try {
            fn(payload);
          } catch {
            /* */
          }
    },
    nodes,
    components,
    events,
    connected: false,
    sibuVersion: "1.0.0",
  };
}

// ---------------------------------------------------------------------------
// Install or reuse global hook
// ---------------------------------------------------------------------------

function getOrCreateHook(): SibuGlobalHook {
  const g = globalThis as any;
  if (!g.__SIBU_DEVTOOLS_GLOBAL_HOOK__) {
    g.__SIBU_DEVTOOLS_GLOBAL_HOOK__ = createGlobalHook();
  }
  return g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
}

// ---------------------------------------------------------------------------
// initDevTools
// ---------------------------------------------------------------------------

let activeDevTools: ReturnType<typeof initDevTools> | null = null;
let nextNodeId = 0;

export function getActiveDevTools(): ReturnType<typeof initDevTools> | null {
  return activeDevTools;
}

/**
 * Initialize Sibu DevTools.
 * Connects to __SIBU_DEVTOOLS_GLOBAL_HOOK__ and starts tracking signals,
 * computed values, effects, and components.
 */
export function initDevTools(config?: DevToolsConfig) {
  const maxEvents = config?.maxEvents ?? 1000;
  // Default to enabled only in dev mode — production builds get a no-op API
  // unless explicitly opted in via { enabled: true }.
  const enabled = config?.enabled ?? isDev();
  if (!enabled) return createNoopApi();

  const hook = getOrCreateHook();
  nextNodeId = 0;

  // Internal event log (serializable, no DOM refs)
  const eventLog: DevToolsEvent[] = [];

  // ─── Listen to framework events ──────────────────────────────────────────

  hook.on("signal:create", (payload: unknown) => {
    const p = payload as { signal: object; getter: () => unknown; initial: unknown };
    nextNodeId++;
    const name = inferName();
    const node: DevNode = {
      id: nextNodeId,
      type: "signal",
      name,
      ref: p.signal,
      getter: p.getter,
      createdAt: Date.now(),
    };
    hook.nodes.set(nextNodeId, node);
  });

  hook.on("signal:update", (payload: unknown) => {
    if (!isActive) return;
    const p = payload as { signal: object; oldValue: unknown; newValue: unknown };
    // Skip if this signal is managed by devState (it records its own events)
    if (devStateManagedRefs.has(p.signal)) return;
    const node = findNodeByRef(hook, p.signal);
    pushEvent(eventLog, maxEvents, {
      type: "state-change",
      component: node?.name || "unknown",
      key: "value",
      oldValue: p.oldValue,
      newValue: p.newValue,
      timestamp: Date.now(),
    });
  });

  hook.on("computed:create", (payload: unknown) => {
    const p = payload as { signal: object; getter: () => unknown };
    nextNodeId++;
    const name = inferName();
    const node: DevNode = {
      id: nextNodeId,
      type: "computed",
      name,
      ref: p.signal,
      getter: p.getter,
      createdAt: Date.now(),
    };
    hook.nodes.set(nextNodeId, node);
  });

  hook.on("computed:update", (payload: unknown) => {
    const p = payload as { signal: object; oldValue: unknown; newValue: unknown };
    const node = findNodeByRef(hook, p.signal);
    pushEvent(eventLog, maxEvents, {
      type: "state-change",
      component: node?.name || "computed",
      key: "value",
      oldValue: p.oldValue,
      newValue: p.newValue,
      timestamp: Date.now(),
    });
  });

  hook.on("effect:create", (payload: unknown) => {
    nextNodeId++;
    const name = inferName();
    const p = payload as { effectFn: () => void };
    const node: DevNode = { id: nextNodeId, type: "effect", name, ref: p.effectFn, createdAt: Date.now() };
    hook.nodes.set(nextNodeId, node);
  });

  hook.on("effect:run", (payload: unknown) => {
    const p = payload as { effectFn: () => void; runCount: number };
    const node = findNodeByRef(hook, p.effectFn);
    pushEvent(eventLog, maxEvents, {
      type: "render",
      component: node?.name || "effect",
      duration: 0,
      timestamp: Date.now(),
    });
  });

  hook.on("app:init", (payload: unknown) => {
    const p = payload as { rootElement: Node; container: Element; duration: number };
    pushEvent(eventLog, maxEvents, {
      type: "render",
      component: "App",
      duration: p.duration,
      timestamp: Date.now(),
    });
    // Auto-discover components
    if (typeof document !== "undefined") {
      queueMicrotask(() => discoverComponents(hook, eventLog, maxEvents));
    }
  });

  // ─── API for backward compatibility + extension ──────────────────────────

  function record(event: DevToolsEvent): void {
    if (isActive) pushEvent(eventLog, maxEvents, event);
  }
  function getEvents(filter?: { type?: string; component?: string }): DevToolsEvent[] {
    if (!filter) return eventLog.slice();
    return eventLog.filter((e) => {
      if (filter.type && e.type !== filter.type) return false;
      if (filter.component && e.component !== filter.component) return false;
      return true;
    });
  }
  function clearEvents(): void {
    eventLog.length = 0;
  }
  function registerComponent(name: string, element: HTMLElement, state?: Record<string, unknown>): void {
    hook.components.set(name, { element, state });
  }
  function unregisterComponent(name: string): void {
    hook.components.delete(name);
  }
  function getComponents(): Map<string, ComponentEntry> {
    return new Map(hook.components);
  }

  function getSignals(): Array<{ id: number; name: string; type: string; value: unknown; subscriberCount: number }> {
    const result: Array<{ id: number; name: string; type: string; value: unknown; subscriberCount: number }> = [];
    for (const [, node] of hook.nodes) {
      let value: unknown;
      try {
        if (node.getter) value = node.getter();
        else if (node.ref && "value" in node.ref) value = node.ref.value;
        else value = undefined;
      } catch {
        value = "<error>";
      }
      const subs = node.ref?.__s;
      result.push({
        id: node.id,
        name: node.name,
        type: node.type,
        value,
        subscriberCount: subs instanceof Set ? subs.size : 0,
      });
    }
    return result;
  }

  let isActive: boolean = enabled;
  function isEnabled(): boolean {
    return isActive;
  }
  function setEnabled(v: boolean): void {
    isActive = v;
  }
  function snapshot(): Record<string, unknown> {
    const snap: Record<string, unknown> = {};
    for (const [name, entry] of hook.components) snap[name] = entry.state ? { ...entry.state } : {};
    return snap;
  }
  function highlightElement(name: string): void {
    const prev = document.querySelector("[data-sibu-highlight]");
    if (prev) {
      (prev as HTMLElement).style.outline = "";
      prev.removeAttribute("data-sibu-highlight");
    }
    const entry = hook.components.get(name);
    if (entry?.element?.isConnected) {
      entry.element.style.outline = "2px solid #89b4fa";
      entry.element.setAttribute("data-sibu-highlight", "true");
      entry.element.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => {
        entry.element.style.outline = "";
        entry.element.removeAttribute("data-sibu-highlight");
      }, 3000);
    }
  }
  function destroy(): void {
    eventLog.length = 0;
    hook.nodes.clear();
    hook.components.clear();
    hook.events.length = 0;
    isActive = false;
    activeDevTools = null;
    const g = globalThis as any;
    if (g.__SIBU_DEVTOOLS__ === api) delete g.__SIBU_DEVTOOLS__;
    // Remove the hook so listeners don't leak between tests/instances
    if (g.__SIBU_DEVTOOLS_GLOBAL_HOOK__ === hook) delete g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  }

  const api = {
    record,
    getEvents,
    clearEvents,
    registerComponent,
    unregisterComponent,
    getComponents,
    getSignals,
    isEnabled,
    setEnabled,
    snapshot,
    highlightElement,
    destroy,
  };

  // Expose API on window
  if (typeof window !== "undefined") {
    (window as any).__SIBU_DEVTOOLS__ = api;

    // Change counter — incremented on every event. The panel checks this
    // cheaply and only does a full data read when it changes.
    let changeVersion = 0;
    const origPush = eventLog.push.bind(eventLog);
    eventLog.push = (...args: DevToolsEvent[]) => {
      changeVersion++;
      return origPush(...args);
    };
    // Also increment on node additions
    const origNodeSet = hook.nodes.set.bind(hook.nodes);
    hook.nodes.set = (k: number, v: DevNode) => {
      changeVersion++;
      return origNodeSet(k, v);
    };
    const origCompSet = hook.components.set.bind(hook.components);
    hook.components.set = (k: string, v: ComponentEntry) => {
      changeVersion++;
      return origCompSet(k, v);
    };

    (window as any).__SIBU_DEVTOOLS_VERSION__ = (): number => changeVersion;

    // Install __SIBU_DEVTOOLS_DATA__
    (window as any).__SIBU_DEVTOOLS_DATA__ = (): string => {
      const sArr: Array<{ id: number; n: string; tp: string; v: string; fv: string; sc: number }> = [];
      for (const [, node] of hook.nodes) {
        let val = "";
        try {
          let raw: unknown;
          // Read value directly from internal state — never call getter
          // to avoid registering spurious reactive dependencies
          if (node.type === "signal" && node.ref && "value" in node.ref) {
            raw = node.ref.value;
          } else if (node.type === "computed" && node.ref) {
            // If dirty, re-evaluate to get current value
            if (node.ref._d && node.ref._g) {
              try {
                raw = node.ref._g();
              } catch {
                raw = node.ref._v;
              }
            } else {
              raw = node.ref._v;
            }
          } else if (node.type === "effect") {
            raw = undefined; // effects don't have values
          } else if (node.ref && "value" in node.ref) {
            raw = node.ref.value;
          }
          if (raw === undefined) val = "undefined";
          else if (raw === null) val = "null";
          else if (typeof raw === "object") val = JSON.stringify(raw);
          else val = String(raw);
        } catch {
          val = "?";
        }
        const fullVal = val;
        const shortVal = val.length > 80 ? `${val.substring(0, 80)}...` : val;

        const subs = node.ref?.__s;
        sArr.push({
          id: node.id,
          n: node.name,
          tp: node.type,
          v: shortVal,
          fv: fullVal,
          sc: subs instanceof Set ? subs.size : 0,
        });
      }

      interface CNode {
        tg: string;
        id: string;
        cl: string;
        txt: string;
        html: string;
        ev: string[];
        ch: CNode[];
      }

      function walkElement(el: Element, depth: number): CNode[] {
        if (depth > 8) return [];
        const result: CNode[] = [];
        const max = Math.min(el.children.length, 50);
        for (let i = 0; i < max; i++) {
          const child = el.children[i] as HTMLElement;
          // Collect text from direct child text nodes and immediate children's text
          const txtParts: string[] = [];
          for (let ti = 0; ti < child.childNodes.length; ti++) {
            const cn = child.childNodes[ti];
            if (cn.nodeType === 3) {
              const t = cn.textContent?.trim();
              if (t) txtParts.push(t);
            } else if (cn.nodeType === 1) {
              // For element children, get their own direct text (not deep)
              const el2 = cn as HTMLElement;
              let directTxt = "";
              for (let ci = 0; ci < el2.childNodes.length; ci++) {
                if (el2.childNodes[ci].nodeType === 3) {
                  const t2 = el2.childNodes[ci].textContent?.trim();
                  if (t2) {
                    directTxt = t2;
                    break;
                  }
                }
              }
              if (directTxt) txtParts.push(directTxt);
            }
          }
          let txt = txtParts.join(" | ");
          if (txt.length > 120) txt = `${txt.substring(0, 120)}...`;
          let html = "";
          try {
            const outer = child.outerHTML || "";
            html = outer.length > 500 ? `${outer.substring(0, 500)}...` : outer;
          } catch {
            html = "";
          }
          const ev: string[] = ((child as unknown as Record<string, unknown>).__sibu_events__ as string[]) || [];
          result.push({
            tg: child.tagName ? child.tagName.toLowerCase() : "?",
            id: child.id || "",
            cl: (child.className || "").toString().split(" ").slice(0, 3).join(" "),
            txt: txt.length > 60 ? `${txt.substring(0, 60)}...` : txt,
            html,
            ev,
            ch: child.childElementCount > 0 ? walkElement(child, depth + 1) : [],
          });
        }
        return result;
      }

      const cArr: Array<{ n: string; tg: string; ch: number; cn: boolean; kids: CNode[] }> = [];
      for (const [name, entry] of hook.components) {
        const el = entry.element;
        cArr.push({
          n: name,
          tg: el?.tagName ? el.tagName.toLowerCase() : "?",
          ch: el?.childElementCount || 0,
          cn: !!el?.isConnected,
          kids: el ? walkElement(el, 0) : [],
        });
      }

      const eArr: Array<{ t: string; c: string; ts: number; d: string; ov: string; nv: string; k: string }> = [];
      const start = eventLog.length > 500 ? eventLog.length - 500 : 0;
      for (let i = start; i < eventLog.length; i++) {
        const e = eventLog[i];
        let detail = "";
        let ov = "";
        let nv = "";
        let key = "";
        if (e.type === "state-change") {
          const sc = e as { oldValue: unknown; newValue: unknown; key: string };
          key = sc.key || "";
          try {
            ov =
              sc.oldValue === undefined
                ? "undefined"
                : sc.oldValue === null
                  ? "null"
                  : typeof sc.oldValue === "object"
                    ? JSON.stringify(sc.oldValue, null, 2)
                    : String(sc.oldValue);
          } catch {
            ov = "?";
          }
          try {
            nv =
              sc.newValue === undefined
                ? "undefined"
                : sc.newValue === null
                  ? "null"
                  : typeof sc.newValue === "object"
                    ? JSON.stringify(sc.newValue, null, 2)
                    : String(sc.newValue);
          } catch {
            nv = "?";
          }
          const ovShort = ov.length > 40 ? `${ov.substring(0, 40)}...` : ov;
          const nvShort = nv.length > 40 ? `${nv.substring(0, 40)}...` : nv;
          detail = `${ovShort} → ${nvShort}`;
        } else if (e.type === "render") {
          detail = `${(e as { duration: number }).duration.toFixed(1)}ms`;
        }
        eArr.push({ t: e.type, c: e.component, ts: e.timestamp, d: detail, ov, nv, k: key });
      }

      return JSON.stringify({ s: sArr, c: cArr, e: eArr });
    };
  }

  activeDevTools = api;

  // DOM component auto-discovery
  if (typeof document !== "undefined") {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLElement) {
            const name = node.getAttribute("data-component") || node.id;
            if (name && !hook.components.has(name)) {
              hook.components.set(name, { element: node });
              pushEvent(eventLog, maxEvents, { type: "mount", component: name, element: node, timestamp: Date.now() });
            }
          }
        }
        for (const node of m.removedNodes) {
          if (node instanceof HTMLElement) {
            const name = node.getAttribute("data-component") || node.id;
            if (name && hook.components.has(name)) {
              pushEvent(eventLog, maxEvents, { type: "unmount", component: name, timestamp: Date.now() });
              hook.components.delete(name);
            }
          }
        }
      }
    });
    queueMicrotask(() => {
      if (!document.body) return;
      observer.observe(document.body, { childList: true, subtree: true });

      // Discover elements with data-component
      document.querySelectorAll("[data-component]").forEach((el) => {
        const name = el.getAttribute("data-component")!;
        if (!hook.components.has(name)) {
          hook.components.set(name, { element: el as HTMLElement });
          pushEvent(eventLog, maxEvents, {
            type: "mount",
            component: name,
            element: el as HTMLElement,
            timestamp: Date.now(),
          });
        }
      });

      // Discover elements with id
      document.querySelectorAll("[id]").forEach((el) => {
        if (el.id && !hook.components.has(el.id)) {
          hook.components.set(el.id, { element: el as HTMLElement });
          pushEvent(eventLog, maxEvents, {
            type: "mount",
            component: el.id,
            element: el as HTMLElement,
            timestamp: Date.now(),
          });
        }
      });

      // Discover semantic elements (section, aside, nav, main, header, footer, article)
      const semanticTags = ["section", "aside", "nav", "main", "header", "footer", "article"];
      for (const tag of semanticTags) {
        document.querySelectorAll(tag).forEach((el, i) => {
          const name = el.getAttribute("data-component") || el.id || `${tag}-${i}`;
          if (!hook.components.has(name)) {
            hook.components.set(name, { element: el as HTMLElement });
            pushEvent(eventLog, maxEvents, {
              type: "mount",
              component: name,
              element: el as HTMLElement,
              timestamp: Date.now(),
            });
          }
        });
      }
    });
  }

  return api;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function inferName(): string {
  try {
    const stack = new Error().stack || "";
    for (const line of stack.split("\n")) {
      const t = line.trim();
      if (
        t.includes("signal") ||
        t.includes("derived") ||
        t.includes("effect") ||
        t.includes("initDevTools") ||
        t.includes("devtools") ||
        t.includes("Error") ||
        t.includes("emit") ||
        t.includes("getOrCreateHook")
      )
        continue;
      const m = t.match(/at\s+(\w+)/);
      if (m && m[1] !== "Object" && m[1] !== "Module" && m[1] !== "anonymous") return m[1];
      const f = t.match(/\/([^/]+?)\.(?:ts|js|tsx|jsx)/);
      if (f) return f[1];
    }
  } catch {
    /* */
  }
  return "anonymous";
}

function findNodeByRef(hook: SibuGlobalHook, ref: object): DevNode | undefined {
  for (const [, node] of hook.nodes) {
    if (node.ref === ref) return node;
  }
  return undefined;
}

function pushEvent(log: DevToolsEvent[], max: number, event: DevToolsEvent): void {
  log.push(event);
  if (log.length > max) log.splice(0, log.length - max);
}

function discoverComponents(hook: SibuGlobalHook, log: DevToolsEvent[], max: number): void {
  if (!document.body) return;
  document.querySelectorAll("[id]").forEach((el) => {
    if (el.id && !hook.components.has(el.id)) {
      hook.components.set(el.id, { element: el as HTMLElement });
      pushEvent(log, max, { type: "mount", component: el.id, element: el as HTMLElement, timestamp: Date.now() });
    }
  });
  document.querySelectorAll("[data-component]").forEach((el) => {
    const name = el.getAttribute("data-component")!;
    if (!hook.components.has(name)) {
      hook.components.set(name, { element: el as HTMLElement });
      pushEvent(log, max, { type: "mount", component: name, element: el as HTMLElement, timestamp: Date.now() });
    }
  });
}

function createNoopApi() {
  const noop = () => {};
  return {
    record: noop as (e: DevToolsEvent) => void,
    getEvents: () => [] as DevToolsEvent[],
    clearEvents: noop,
    registerComponent: noop as (n: string, el: HTMLElement, s?: Record<string, unknown>) => void,
    unregisterComponent: noop as (n: string) => void,
    getComponents: () => new Map<string, ComponentEntry>(),
    getSignals: () => [] as Array<{ id: number; name: string; type: string; value: unknown; subscriberCount: number }>,
    isEnabled: () => false,
    setEnabled: noop,
    snapshot: () => ({}) as Record<string, unknown>,
    highlightElement: noop as (n: string) => void,
    destroy: noop,
  };
}

// ---------------------------------------------------------------------------
// devState — backward compat
// ---------------------------------------------------------------------------

// Refs managed by devState — auto-hook skips these
const devStateManagedRefs = new WeakSet<object>();

export function devState<T>(name: string, initial: T): [() => T, (value: T | ((prev: T) => T)) => void] {
  const hook = (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__ as SibuGlobalHook | undefined;

  // Count nodes before signal to find the one it creates
  const nodeCountBefore = hook ? hook.nodes.size : 0;

  const [get, set] = _sbSignal<T>(initial);

  // Rename the node that signal just registered and mark its ref
  if (hook && hook.nodes.size > nodeCountBefore) {
    const entries = Array.from(hook.nodes.values());
    const lastNode = entries[entries.length - 1];
    if (lastNode) {
      lastNode.name = name;
      if (lastNode.ref) devStateManagedRefs.add(lastNode.ref);
    }
  }

  const dotIndex = name.indexOf(".");
  const component = dotIndex !== -1 ? name.slice(0, dotIndex) : name;
  const key = dotIndex !== -1 ? name.slice(dotIndex + 1) : name;

  function trackedSet(next: T | ((prev: T) => T)): void {
    const oldValue = get();
    set(next); // auto-hook signal:update is SKIPPED because ref is in devStateManagedRefs
    const newValue = get();

    // Record with proper component/key names
    const dt = activeDevTools;
    if (dt?.isEnabled() && !Object.is(oldValue, newValue)) {
      dt.record({ type: "state-change", component, key, oldValue, newValue, timestamp: Date.now() });
    }
  }

  return [get, trackedSet];
}
