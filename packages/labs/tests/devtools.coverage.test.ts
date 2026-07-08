import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devState, getActiveDevTools, initDevTools } from "../src/devtools/devtools";

// These tests drive the UNCOVERED paths of devtools.ts: the global-hook event
// listeners (signal/computed/effect create+update, app:init), getSignals,
// buildData (via expose), highlightElement, getElementHTML, and DOM
// auto-discovery through the MutationObserver / querySelector scan.

type Hook = {
  on: (event: string, fn: (...args: unknown[]) => void) => void;
  off: (event: string, fn: (...args: unknown[]) => void) => void;
  emit: (event: string, payload: unknown) => void;
  nodes: Map<number, unknown>;
  components: Map<string, unknown>;
  events: unknown[];
  connected: boolean;
  sibuVersion: string;
};

function getHook(): Hook {
  return (globalThis as unknown as Record<string, Hook>).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
}

function cleanup(): void {
  const prev = getActiveDevTools();
  if (prev) prev.destroy();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__SIBU__;
  delete (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS__;
  delete (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS_VERSION__;
  delete (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS_DATA__;
  document.body.innerHTML = "";
}

describe("devtools global hook event listeners", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("registers a node on signal:create and exposes it via getSignals", () => {
    const dt = initDevTools();
    const hook = getHook();
    const sigRef = { value: 7, __sc: 2 };

    hook.emit("signal:create", { signal: sigRef, getter: () => sigRef.value, initial: 7 });

    const signals = dt.getSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe("signal");
    expect(signals[0].value).toBe(7);
    expect(signals[0].subscriberCount).toBe(2);
  });

  it("records a state-change event on signal:update for a known node", () => {
    const dt = initDevTools();
    const hook = getHook();
    const sigRef = { value: 1, __sc: 0 };

    hook.emit("signal:create", { signal: sigRef, getter: () => sigRef.value, initial: 1 });
    hook.emit("signal:update", { signal: sigRef, oldValue: 1, newValue: 2 });

    const events = dt.getEvents({ type: "state-change" });
    expect(events).toHaveLength(1);
    expect((events[0] as { oldValue: unknown }).oldValue).toBe(1);
    expect((events[0] as { newValue: unknown }).newValue).toBe(2);
  });

  it("ignores signal:update when devtools are not active", () => {
    const dt = initDevTools();
    const hook = getHook();
    dt.setEnabled(false);

    hook.emit("signal:update", { signal: { value: 0 }, oldValue: 0, newValue: 1 });

    expect(dt.getEvents({ type: "state-change" })).toHaveLength(0);
  });

  it("records computed:create and computed:update events", () => {
    const dt = initDevTools();
    const hook = getHook();
    const cRef = { value: 4, __sc: 1 };

    hook.emit("computed:create", { signal: cRef, getter: () => cRef.value });
    hook.emit("computed:update", { signal: cRef, oldValue: 4, newValue: 8 });

    const signals = dt.getSignals();
    expect(signals.some((s) => s.type === "computed")).toBe(true);

    const events = dt.getEvents({ type: "state-change" });
    expect(events).toHaveLength(1);
    expect((events[0] as { newValue: unknown }).newValue).toBe(8);
  });

  it("falls back to 'computed' component name when update has no known node", () => {
    const dt = initDevTools();
    const hook = getHook();

    hook.emit("computed:update", { signal: { value: 0 }, oldValue: 0, newValue: 1 });

    const events = dt.getEvents({ type: "state-change" });
    expect(events).toHaveLength(1);
    expect(events[0].component).toBe("computed");
  });

  it("records effect:create and effect:run events", () => {
    const dt = initDevTools();
    const hook = getHook();
    const effectFn = () => {};

    hook.emit("effect:create", { effectFn });
    hook.emit("effect:run", { effectFn, runCount: 1 });

    const signals = dt.getSignals();
    expect(signals.some((s) => s.type === "effect")).toBe(true);

    const renders = dt.getEvents({ type: "render" });
    expect(renders).toHaveLength(1);
    expect(renders[0].component).not.toBe("");
  });

  it("falls back to 'effect' component name for an unknown effect:run", () => {
    const dt = initDevTools();
    const hook = getHook();

    hook.emit("effect:run", { effectFn: () => {}, runCount: 1 });

    const renders = dt.getEvents({ type: "render" });
    expect(renders).toHaveLength(1);
    expect(renders[0].component).toBe("effect");
  });

  it("records an App render and auto-discovers components on app:init", async () => {
    const dt = initDevTools();
    const hook = getHook();

    const el = document.createElement("div");
    el.id = "discovered-by-init";
    document.body.appendChild(el);

    hook.emit("app:init", { rootElement: el, container: document.body, duration: 12.5 });

    const renders = dt.getEvents({ type: "render" });
    expect(renders.some((r) => r.component === "App")).toBe(true);

    // app:init schedules a microtask that discovers components
    await Promise.resolve();
    await Promise.resolve();

    expect(dt.getComponents().has("discovered-by-init")).toBe(true);
  });

  it("listeners swallow errors thrown by a subscriber (emit try/catch)", () => {
    initDevTools();
    const hook = getHook();
    hook.on("custom:event", () => {
      throw new Error("boom");
    });
    expect(() => hook.emit("custom:event", {})).not.toThrow();
  });

  it("supports off() to remove a listener", () => {
    initDevTools();
    const hook = getHook();
    let calls = 0;
    const fn = () => {
      calls++;
    };
    hook.on("ping", fn);
    hook.emit("ping", {});
    hook.off("ping", fn);
    hook.emit("ping", {});
    expect(calls).toBe(1);
  });
});

describe("devtools getSignals value resolution", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("reads value from ref.value when there is no getter", () => {
    const dt = initDevTools();
    const hook = getHook();
    hook.emit("computed:create", { signal: { value: 99, __sc: 0 } });
    const signals = dt.getSignals();
    expect(signals[0].value).toBe(99);
  });

  it("returns <error> when the getter throws", () => {
    const dt = initDevTools();
    const hook = getHook();
    hook.emit("signal:create", {
      signal: {},
      getter: () => {
        throw new Error("nope");
      },
      initial: 0,
    });
    const signals = dt.getSignals();
    expect(signals[0].value).toBe("<error>");
  });
});

describe("devtools highlightElement / getElementHTML", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("highlights a connected registered element and restores after timeout", () => {
    vi.useFakeTimers();
    try {
      const dt = initDevTools();
      const el = document.createElement("div");
      el.scrollIntoView = vi.fn();
      el.style.outline = "1px dashed red";
      document.body.appendChild(el);
      dt.registerComponent("Card", el);

      dt.highlightElement("Card");
      expect(el.getAttribute("data-sibu-highlight")).toBe("true");
      expect(el.style.outline).toBe("2px solid #89b4fa");

      vi.runAllTimers();
      // Original inline outline restored
      expect(el.style.outline).toBe("1px dashed red");
      expect(el.hasAttribute("data-sibu-highlight")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a previously highlighted element before highlighting a new one", () => {
    vi.useFakeTimers();
    try {
      const dt = initDevTools();
      const a = document.createElement("div");
      const b = document.createElement("div");
      a.scrollIntoView = vi.fn();
      b.scrollIntoView = vi.fn();
      document.body.append(a, b);
      dt.registerComponent("A", a);
      dt.registerComponent("B", b);

      dt.highlightElement("A");
      expect(a.getAttribute("data-sibu-highlight")).toBe("true");

      dt.highlightElement("B");
      // A should be restored, B highlighted
      expect(a.hasAttribute("data-sibu-highlight")).toBe(false);
      expect(b.getAttribute("data-sibu-highlight")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing when highlighting a disconnected element", () => {
    const dt = initDevTools();
    const el = document.createElement("div");
    dt.registerComponent("Detached", el); // not appended -> not connected
    expect(() => dt.highlightElement("Detached")).not.toThrow();
    expect(el.hasAttribute("data-sibu-highlight")).toBe(false);
  });

  it("does nothing for an unknown component name", () => {
    const dt = initDevTools();
    expect(() => dt.highlightElement("missing")).not.toThrow();
  });

  it("returns sanitized HTML for a registered element", () => {
    const dt = initDevTools();
    const el = document.createElement("div");
    el.innerHTML = "<span>hi</span>";
    dt.registerComponent("Widget", el);

    const html = dt.getElementHTML("Widget");
    // stripHtml removes tags/scripts, leaving sanitized text content
    expect(html).not.toBeNull();
    expect(html).toContain("hi");
  });

  it("truncates HTML beyond the max length", () => {
    const dt = initDevTools();
    const el = document.createElement("div");
    el.textContent = "x".repeat(500);
    dt.registerComponent("Big", el);

    const html = dt.getElementHTML("Big", 50);
    expect(html?.endsWith("...")).toBe(true);
    expect((html as string).length).toBeLessThanOrEqual(53);
  });

  it("returns null for an unknown element", () => {
    const dt = initDevTools();
    expect(dt.getElementHTML("nope")).toBeNull();
  });
});

describe("devtools buildData via expose", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("exposes __SIBU__ data serializer and produces JSON with signals/components/events", () => {
    const dt = initDevTools({ expose: true });
    const hook = getHook();

    // A plain signal node
    hook.emit("signal:create", { signal: { value: "hello", __sc: 1 }, initial: "hello" });
    // A computed node (dirty -> re-evaluate path)
    hook.emit("computed:create", {
      signal: { _d: true, _g: () => ({ a: 1 }), _v: null, __sc: 0 },
    });
    // An effect node (no value)
    hook.emit("effect:create", { effectFn: () => {} });

    // A registered component with children for walkElement
    const el = document.createElement("section");
    el.id = "root";
    el.setAttribute("data-x", "1");
    const child = document.createElement("button");
    child.textContent = "Click";
    (child as unknown as Record<string, unknown>).__sibu_events__ = ["click"];
    el.appendChild(child);
    document.body.appendChild(el);
    dt.registerComponent("Root", el);

    // An event in the log
    dt.record({ type: "render", component: "Root", duration: 3.14, timestamp: 1 });
    dt.record({
      type: "state-change",
      component: "Root",
      key: "count",
      oldValue: { x: 1 },
      newValue: 5,
      timestamp: 2,
    });

    const ns = (globalThis as unknown as { __SIBU__: { data: () => string; changeVersion: () => number } }).__SIBU__;
    expect(typeof ns.data).toBe("function");
    expect(typeof ns.changeVersion()).toBe("number");

    const parsed = JSON.parse(ns.data()) as {
      s: Array<{ tp: string; v: string }>;
      c: Array<{ n: string; kids: unknown[] }>;
      e: Array<{ t: string; d: string }>;
    };

    expect(parsed.s.length).toBe(3);
    expect(parsed.s.some((s) => s.tp === "effect")).toBe(true);
    expect(parsed.c.some((c) => c.n === "Root")).toBe(true);
    expect(parsed.c[0].kids.length).toBeGreaterThan(0);

    const renderEvent = parsed.e.find((e) => e.t === "render");
    expect(renderEvent?.d).toContain("ms");
    expect(parsed.e.some((e) => e.t === "state-change")).toBe(true);

    // Window aliases
    expect(typeof (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS_DATA__).toBe("function");
    expect(typeof (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS_VERSION__).toBe("function");
  });

  it("serializes a computed value from _v when not dirty", () => {
    initDevTools({ expose: true });
    const hook = getHook();
    hook.emit("computed:create", { signal: { _d: false, _g: () => 1, _v: 42, __sc: 0 } });
    const ns = (globalThis as unknown as { __SIBU__: { data: () => string } }).__SIBU__;
    const parsed = JSON.parse(ns.data()) as { s: Array<{ v: string }> };
    expect(parsed.s[0].v).toBe("42");
  });
});

describe("devtools DOM auto-discovery (MutationObserver + initial scan)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("discovers data-component, id, and semantic elements on init", async () => {
    const dc = document.createElement("div");
    dc.setAttribute("data-component", "MyComp");
    const withId = document.createElement("div");
    withId.id = "uniqueId";
    const semantic = document.createElement("nav");
    document.body.append(dc, withId, semantic);

    const dt = initDevTools();

    // initial discovery runs in a queued microtask
    await Promise.resolve();
    await Promise.resolve();

    const comps = dt.getComponents();
    expect(comps.has("MyComp")).toBe(true);
    expect(comps.has("uniqueId")).toBe(true);
    expect(comps.has("nav-0")).toBe(true);

    const mounts = dt.getEvents({ type: "mount" });
    expect(mounts.length).toBeGreaterThanOrEqual(3);
  });

  it("tracks mount and unmount via the MutationObserver", async () => {
    const dt = initDevTools();
    await Promise.resolve();
    await Promise.resolve();

    const added = document.createElement("div");
    added.setAttribute("data-component", "Dynamic");
    document.body.appendChild(added);

    // Wait for MutationObserver to flush (microtask-based in jsdom)
    await new Promise((r) => setTimeout(r, 0));
    expect(dt.getComponents().has("Dynamic")).toBe(true);
    const mounts = dt.getEvents({ type: "mount" });
    expect(mounts.some((m) => m.component === "Dynamic")).toBe(true);

    added.remove();
    await new Promise((r) => setTimeout(r, 0));
    expect(dt.getComponents().has("Dynamic")).toBe(false);
    const unmounts = dt.getEvents({ type: "unmount" });
    expect(unmounts.some((m) => m.component === "Dynamic")).toBe(true);
  });
});

describe("devtools disabled / noop API", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns a no-op API when disabled", () => {
    const dt = initDevTools({ enabled: false });
    const el = document.createElement("div");
    expect(dt.getEvents()).toEqual([]);
    expect(dt.getSignals()).toEqual([]);
    expect(dt.getComponents().size).toBe(0);
    expect(dt.isEnabled()).toBe(false);
    expect(dt.snapshot()).toEqual({});
    expect(dt.getElementHTML("x")).toBeNull();
    expect(() => {
      dt.registerComponent("x", el);
      dt.unregisterComponent("x");
      dt.setEnabled(true);
      dt.highlightElement("x");
      dt.clearEvents();
      dt.destroy();
    }).not.toThrow();
  });
});

describe("devState with active hook node renaming", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("renames the hook node created by the underlying signal", () => {
    initDevTools();
    const hook = getHook();
    const before = hook.nodes.size;

    const [, setVal] = devState("Form.email", "");
    expect(hook.nodes.size).toBeGreaterThan(before);

    // The newest node should carry the devState name
    const nodes = Array.from(hook.nodes.values()) as Array<{ name: string }>;
    expect(nodes[nodes.length - 1].name).toBe("Form.email");

    // And updates through devState are recorded with proper component/key
    setVal("a@b.com");
    const dt = getActiveDevTools();
    const events = dt?.getEvents({ type: "state-change" }) ?? [];
    expect(events.some((e) => e.component === "Form" && (e as { key: string }).key === "email")).toBe(true);
  });
});
