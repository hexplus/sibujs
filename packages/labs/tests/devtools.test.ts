import { beforeEach, describe, expect, it } from "vitest";
import type { DevToolsEvent } from "../src/devtools/devtools";
import { devState, getActiveDevTools, initDevTools } from "../src/devtools/devtools";

type StateChangeEvent = Extract<DevToolsEvent, { type: "state-change" }>;

// =============================================================================
// initDevTools
// =============================================================================

describe("initDevTools", () => {
  beforeEach(() => {
    // Clean up any previous devtools instance
    const prev = getActiveDevTools();
    if (prev) prev.destroy();
    delete (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS__;
  });

  it("should create a devtools instance", () => {
    const dt = initDevTools();
    expect(dt).toBeDefined();
    expect(typeof dt.record).toBe("function");
    expect(typeof dt.getEvents).toBe("function");
    expect(typeof dt.snapshot).toBe("function");
    expect(typeof dt.destroy).toBe("function");
  });

  it("should attach to window.__SIBU_DEVTOOLS__", () => {
    const dt = initDevTools();
    expect((window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS__).toBe(dt);
  });

  it("should be enabled by default", () => {
    const dt = initDevTools();
    expect(dt.isEnabled()).toBe(true);
  });

  it("should respect the enabled config option", () => {
    const dt = initDevTools({ enabled: false });
    expect(dt.isEnabled()).toBe(false);
  });

  it("should record events", () => {
    const dt = initDevTools();
    const el = document.createElement("div");

    dt.record({ type: "mount", component: "App", element: el, timestamp: 1000 });
    dt.record({ type: "render", component: "App", duration: 5, timestamp: 1001 });

    const events = dt.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("mount");
    expect(events[1].type).toBe("render");
  });

  it("should not record events when disabled", () => {
    const dt = initDevTools({ enabled: false });
    const el = document.createElement("div");

    dt.record({ type: "mount", component: "App", element: el, timestamp: 1000 });

    expect(dt.getEvents()).toHaveLength(0);
  });

  it("should toggle enabled state with setEnabled", () => {
    const dt = initDevTools();
    const el = document.createElement("div");

    dt.setEnabled(false);
    dt.record({ type: "mount", component: "App", element: el, timestamp: 1000 });
    expect(dt.getEvents()).toHaveLength(0);

    dt.setEnabled(true);
    dt.record({ type: "mount", component: "App", element: el, timestamp: 1001 });
    expect(dt.getEvents()).toHaveLength(1);
  });

  it("should filter events by type", () => {
    const dt = initDevTools();
    const el = document.createElement("div");

    dt.record({ type: "mount", component: "App", element: el, timestamp: 1 });
    dt.record({ type: "render", component: "App", duration: 5, timestamp: 2 });
    dt.record({ type: "mount", component: "Nav", element: el, timestamp: 3 });
    dt.record({ type: "unmount", component: "App", timestamp: 4 });

    const mounts = dt.getEvents({ type: "mount" });
    expect(mounts).toHaveLength(2);
    expect(mounts.every((e) => e.type === "mount")).toBe(true);
  });

  it("should filter events by component", () => {
    const dt = initDevTools();
    const el = document.createElement("div");

    dt.record({ type: "mount", component: "App", element: el, timestamp: 1 });
    dt.record({ type: "render", component: "Nav", duration: 3, timestamp: 2 });
    dt.record({ type: "unmount", component: "App", timestamp: 3 });

    const appEvents = dt.getEvents({ component: "App" });
    expect(appEvents).toHaveLength(2);
    expect(appEvents.every((e) => e.component === "App")).toBe(true);
  });

  it("should filter events by both type and component", () => {
    const dt = initDevTools();
    const el = document.createElement("div");

    dt.record({ type: "mount", component: "App", element: el, timestamp: 1 });
    dt.record({ type: "mount", component: "Nav", element: el, timestamp: 2 });
    dt.record({ type: "render", component: "App", duration: 5, timestamp: 3 });

    const filtered = dt.getEvents({ type: "mount", component: "App" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].component).toBe("App");
    expect(filtered[0].type).toBe("mount");
  });

  it("should trim events when exceeding maxEvents", () => {
    const dt = initDevTools({ maxEvents: 3 });
    const el = document.createElement("div");

    dt.record({ type: "mount", component: "A", element: el, timestamp: 1 });
    dt.record({ type: "mount", component: "B", element: el, timestamp: 2 });
    dt.record({ type: "mount", component: "C", element: el, timestamp: 3 });
    dt.record({ type: "mount", component: "D", element: el, timestamp: 4 });

    const events = dt.getEvents();
    expect(events).toHaveLength(3);
    // Oldest event (A) should have been trimmed
    expect(events[0].component).toBe("B");
    expect(events[2].component).toBe("D");
  });

  it("clearEvents() should remove all recorded events", () => {
    const dt = initDevTools();
    const el = document.createElement("div");

    dt.record({ type: "mount", component: "App", element: el, timestamp: 1 });
    dt.record({ type: "render", component: "App", duration: 5, timestamp: 2 });

    dt.clearEvents();

    expect(dt.getEvents()).toHaveLength(0);
  });

  it("should register and retrieve components", () => {
    const dt = initDevTools();
    const el = document.createElement("div");

    dt.registerComponent("Counter", el, { count: 0 });

    const components = dt.getComponents();
    expect(components.has("Counter")).toBe(true);
    expect(components.get("Counter")?.element).toBe(el);
    expect(components.get("Counter")?.state).toEqual({ count: 0 });
  });

  it("should unregister components", () => {
    const dt = initDevTools();
    const el = document.createElement("div");

    dt.registerComponent("Counter", el);
    dt.unregisterComponent("Counter");

    expect(dt.getComponents().has("Counter")).toBe(false);
  });

  it("getComponents() should return a copy, not the internal map", () => {
    const dt = initDevTools();
    const el = document.createElement("div");

    dt.registerComponent("Counter", el);

    const components = dt.getComponents();
    components.delete("Counter");

    // Original should not be affected
    expect(dt.getComponents().has("Counter")).toBe(true);
  });

  it("snapshot() should return state of all registered components", () => {
    const dt = initDevTools();
    const el1 = document.createElement("div");
    const el2 = document.createElement("div");

    dt.registerComponent("Counter", el1, { count: 5 });
    dt.registerComponent("TodoList", el2, { items: ["a", "b"] });

    const snap = dt.snapshot();
    expect(snap).toEqual({
      Counter: { count: 5 },
      TodoList: { items: ["a", "b"] },
    });
  });

  it("snapshot() should return empty object for components with no state", () => {
    const dt = initDevTools();
    const el = document.createElement("div");

    dt.registerComponent("Stateless", el);

    const snap = dt.snapshot();
    expect(snap.Stateless).toEqual({});
  });

  it("snapshot() should return a shallow copy of state", () => {
    const dt = initDevTools();
    const el = document.createElement("div");
    const state = { count: 10 };

    dt.registerComponent("Counter", el, state);

    const snap = dt.snapshot() as Record<string, Record<string, unknown>>;
    // Modifying the snapshot should not affect the original
    snap.Counter.count = 999;
    expect(state.count).toBe(10);
  });

  it("destroy() should clean up events, components, and window reference", () => {
    const dt = initDevTools();
    const el = document.createElement("div");

    dt.registerComponent("App", el, { ready: true });
    dt.record({ type: "mount", component: "App", element: el, timestamp: 1 });

    dt.destroy();

    expect(dt.isEnabled()).toBe(false);
    expect(dt.getEvents()).toHaveLength(0);
    expect(dt.getComponents().size).toBe(0);
    expect((window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS__).toBeUndefined();
  });

  it("destroy() should clear the active devtools reference", () => {
    initDevTools();
    expect(getActiveDevTools()).not.toBeNull();

    getActiveDevTools()?.destroy();
    expect(getActiveDevTools()).toBeNull();
  });
});

// =============================================================================
// devState
// =============================================================================

describe("devState", () => {
  beforeEach(() => {
    // Clean up any previous devtools instance
    const prev = getActiveDevTools();
    if (prev) prev.destroy();
    delete (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS__;
  });

  it("should create state with initial value (like signal)", () => {
    const [count] = devState("Counter.count", 0);
    expect(count()).toBe(0);
  });

  it("should update state with a new value", () => {
    const [count, setCount] = devState("Counter.count", 10);
    setCount(20);
    expect(count()).toBe(20);
  });

  it("should accept an updater function", () => {
    const [count, setCount] = devState("Counter.count", 5);
    setCount((prev) => prev + 1);
    expect(count()).toBe(6);
  });

  it("should record state changes to active devtools", () => {
    const dt = initDevTools();
    const [_count, setCount] = devState("Counter.count", 0);

    setCount(1);
    setCount(2);

    const events = dt.getEvents({ type: "state-change" });
    expect(events).toHaveLength(2);

    const first = events[0] as StateChangeEvent;
    expect(first.component).toBe("Counter");
    expect(first.key).toBe("count");
    expect(first.oldValue).toBe(0);
    expect(first.newValue).toBe(1);

    const second = events[1] as StateChangeEvent;
    expect(second.oldValue).toBe(1);
    expect(second.newValue).toBe(2);
  });

  it("should not record when devtools are not active", () => {
    // No initDevTools() called, so activeDevTools is null
    const [, setCount] = devState("Counter.count", 0);
    setCount(1);

    // No devtools, no errors, and no events recorded
    expect(getActiveDevTools()).toBeNull();
  });

  it("should not record when devtools are disabled", () => {
    const dt = initDevTools({ enabled: true });
    const [, setCount] = devState("Counter.count", 0);

    dt.setEnabled(false);
    setCount(1);

    expect(dt.getEvents()).toHaveLength(0);
  });

  it("should use the full name as both component and key when no dot separator", () => {
    const dt = initDevTools();
    const [, setVal] = devState("globalFlag", false);

    setVal(true);

    const events = dt.getEvents({ type: "state-change" });
    expect(events).toHaveLength(1);

    const event = events[0] as StateChangeEvent;
    expect(event.component).toBe("globalFlag");
    expect(event.key).toBe("globalFlag");
  });

  it("should work with complex state values", () => {
    const dt = initDevTools();
    const [_items, setItems] = devState<string[]>("TodoList.items", []);

    setItems(["a", "b"]);

    const events = dt.getEvents({ type: "state-change" });
    expect(events).toHaveLength(1);

    const event = events[0] as StateChangeEvent;
    expect(event.oldValue).toEqual([]);
    expect(event.newValue).toEqual(["a", "b"]);
  });
});
