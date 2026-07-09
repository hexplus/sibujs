import { derived, effect, signal } from "@sibujs/core";
import { afterEach, describe, expect, it } from "vitest";
import { getSignalName, getSubscriberCount, inspectSignal, walkDependencyGraph } from "../src/devtools/introspect";

// ── Signal debug names ───────────────────────────────────────────────────────

describe("Signal debug names", () => {
  it("signal with name option tags the getter", () => {
    const [count] = signal(0, { name: "count" });
    expect(getSignalName(count)).toBe("count");
  });

  it("signal without name has undefined debug name", () => {
    const [count] = signal(0);
    expect(getSignalName(count)).toBeUndefined();
  });

  it("derived with name option tags the getter", () => {
    const [count] = signal(0);
    const doubled = derived(() => count() * 2, { name: "doubled" });
    expect(getSignalName(doubled)).toBe("doubled");
  });

  it("derived without name has undefined debug name", () => {
    const [count] = signal(0);
    const doubled = derived(() => count() * 2);
    expect(getSignalName(doubled)).toBeUndefined();
  });

  it("debug name does not affect signal behavior", () => {
    const [count, setCount] = signal(0, { name: "count" });
    setCount(5);
    expect(count()).toBe(5);
  });
});

// ── Subscriber count introspection ───────────────────────────────────────────

describe("Subscriber count", () => {
  it("returns 0 for signal with no subscribers", () => {
    const [count] = signal(0, { name: "lonely" });
    expect(getSubscriberCount(count)).toBe(0);
  });

  it("returns 1 after one effect subscribes", () => {
    const [count] = signal(0);
    const teardown = effect(() => count());
    expect(getSubscriberCount(count)).toBe(1);
    teardown();
  });

  it("returns correct count with multiple subscribers", () => {
    const [count] = signal(0);
    const t1 = effect(() => count());
    const t2 = effect(() => count());
    const t3 = effect(() => count());
    expect(getSubscriberCount(count)).toBe(3);
    t1();
    t2();
    t3();
  });

  it("decrements when subscriber is disposed", () => {
    const [count] = signal(0);
    const t1 = effect(() => count());
    const t2 = effect(() => count());
    expect(getSubscriberCount(count)).toBe(2);

    t1();
    expect(getSubscriberCount(count)).toBe(1);

    t2();
    expect(getSubscriberCount(count)).toBe(0);
  });

  it("counts computed as a subscriber", () => {
    const [count] = signal(0);
    const _doubled = derived(() => count() * 2);
    // Computed registers as subscriber during track()
    expect(getSubscriberCount(count)).toBeGreaterThanOrEqual(1);
  });
});

// ── inspectSignal ────────────────────────────────────────────────────────────

describe("inspectSignal", () => {
  it("returns info for a named signal", () => {
    const [count] = signal(42, { name: "myCount" });
    const info = inspectSignal(count);

    expect(info).not.toBeNull();
    expect(info?.name).toBe("myCount");
    expect(info?.subscriberCount).toBe(0);
  });

  it("returns null for a non-signal function", () => {
    const notASignal = () => 42;
    expect(inspectSignal(notASignal)).toBeNull();
  });

  it("reflects subscriber count changes", () => {
    const [count] = signal(0, { name: "dynamic" });
    expect(inspectSignal(count)?.subscriberCount).toBe(0);

    const teardown = effect(() => count());
    expect(inspectSignal(count)?.subscriberCount).toBe(1);

    teardown();
    expect(inspectSignal(count)?.subscriberCount).toBe(0);
  });
});

// ── walkDependencyGraph ──────────────────────────────────────────────────────

describe("walkDependencyGraph", () => {
  it("returns basic info for a standalone signal", () => {
    const [count] = signal(0, { name: "root" });
    const graph = walkDependencyGraph(count);

    expect(graph.name).toBe("root");
    expect(graph.subscribers).toBe(0);
    expect(graph.downstream).toEqual([]);
  });

  it("shows computed as downstream subscriber", () => {
    const [count] = signal(0, { name: "source" });
    const doubled = derived(() => count() * 2, { name: "doubled" });

    // Force evaluation so subscription is established
    doubled();

    const graph = walkDependencyGraph(count);
    expect(graph.name).toBe("source");
    expect(graph.subscribers).toBeGreaterThanOrEqual(1);
    expect(graph.downstream.length).toBeGreaterThanOrEqual(1);
    expect(graph.downstream[0].name).toBe("doubled");
  });
});

// ── DevTools global hook events ──────────────────────────────────────────────

describe("DevTools global hook events", () => {
  afterEach(() => {
    delete (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  });

  it("emits signal:create when hook is present", () => {
    const events: unknown[] = [];
    (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__ = {
      emit: (_event: string, payload: unknown) => events.push({ _event, payload }),
    };

    signal(42, { name: "test" });

    const createEvent = events.find((e: any) => e._event === "signal:create") as any;
    expect(createEvent).toBeDefined();
    expect(createEvent.payload.name).toBe("test");
    expect(createEvent.payload.initial).toBe(42);
  });

  it("emits signal:update on setter call", () => {
    const events: unknown[] = [];
    (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__ = {
      emit: (_event: string, payload: unknown) => events.push({ _event, payload }),
    };

    const [, setCount] = signal(0, { name: "counter" });
    setCount(5);

    const updateEvent = events.find((e: any) => e._event === "signal:update") as any;
    expect(updateEvent).toBeDefined();
    expect(updateEvent.payload.name).toBe("counter");
    expect(updateEvent.payload.oldValue).toBe(0);
    expect(updateEvent.payload.newValue).toBe(5);
  });

  it("emits effect:create and effect:destroy", () => {
    const events: unknown[] = [];
    (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__ = {
      emit: (_event: string, payload: unknown) => events.push({ _event, payload }),
    };

    const teardown = effect(() => {});
    expect(events.some((e: any) => e._event === "effect:create")).toBe(true);

    teardown();
    expect(events.some((e: any) => e._event === "effect:destroy")).toBe(true);
  });

  it("zero overhead when hook is absent", () => {
    // No hook installed — should not throw
    const [count, setCount] = signal(0);
    setCount(1);
    expect(count()).toBe(1);
  });
});
