import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureSignalGraph, createTraceProfiler, diffSignalGraphs } from "../src/devtools/signalGraph";

// Drives the UNCOVERED branches of signalGraph.ts: the populated-hook path of
// captureSignalGraph (nodes, edges, derived chains, cycles) and the recording
// branch of createTraceProfiler (effect:create/destroy, signal:update,
// stop/stopTrace, isRecording).

type Handler = (payload: unknown) => void;

interface FakeNode {
  id: string;
  name: string | null;
  kind: string;
  value: string;
  subscribers: string[];
  dependencies: string[];
  evalCount: number;
}

function installHook(nodes: FakeNode[] = []): {
  emit: (event: string, payload: unknown) => void;
  listenerCount: () => number;
} {
  const listeners = new Map<string, Set<Handler>>();
  const hook = {
    emit(event: string, payload: unknown) {
      listeners.get(event)?.forEach((h) => {
        h(payload);
      });
    },
    on(event: string, handler: Handler) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
    off(event: string, handler: Handler) {
      listeners.get(event)?.delete(handler);
    },
    getSignalNodes() {
      return nodes;
    },
  };
  (globalThis as unknown as Record<string, unknown>).__SIBU_DEVTOOLS_GLOBAL_HOOK__ = hook;
  return {
    emit: (e, p) => hook.emit(e, p),
    listenerCount: () => {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

function clearHook(): void {
  delete (globalThis as unknown as Record<string, unknown>).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
}

describe("captureSignalGraph with a populated hook", () => {
  afterEach(clearHook);

  it("captures nodes, counts edges, and preserves derived dependency chains", () => {
    installHook([
      { id: "s1", name: "count", kind: "signal", value: "1", subscribers: ["d1"], dependencies: [], evalCount: 0 },
      {
        id: "d1",
        name: "doubled",
        kind: "derived",
        value: "2",
        subscribers: ["e1"],
        dependencies: ["s1"],
        evalCount: 1,
      },
      { id: "e1", name: null, kind: "effect", value: "", subscribers: [], dependencies: ["d1"], evalCount: 1 },
    ]);

    const snap = captureSignalGraph();
    expect(snap.nodes).toHaveLength(3);
    // edgeCount sums dependencies across all nodes: 0 + 1 + 1 = 2
    expect(snap.edgeCount).toBe(2);

    const derived = snap.nodes.find((n) => n.id === "d1");
    expect(derived?.dependencies).toEqual(["s1"]);
    expect(derived?.subscribers).toEqual(["e1"]);

    // Snapshot arrays are copies, not the originals
    const original = derived?.dependencies as string[];
    original.push("mutated");
    const fresh = captureSignalGraph();
    expect(fresh.nodes.find((n) => n.id === "d1")?.dependencies).toEqual(["s1"]);
  });

  it("handles a dependency cycle without infinite looping", () => {
    installHook([
      { id: "a", name: "a", kind: "signal", value: "1", subscribers: ["b"], dependencies: ["b"], evalCount: 0 },
      { id: "b", name: "b", kind: "derived", value: "2", subscribers: ["a"], dependencies: ["a"], evalCount: 0 },
    ]);
    const snap = captureSignalGraph();
    expect(snap.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(snap.edgeCount).toBe(2);
  });

  it("returns an empty snapshot when the hook lacks getSignalNodes", () => {
    (globalThis as unknown as Record<string, unknown>).__SIBU_DEVTOOLS_GLOBAL_HOOK__ = {
      emit() {},
      on() {
        return () => {};
      },
      off() {},
    };
    const snap = captureSignalGraph();
    expect(snap.nodes).toEqual([]);
    expect(snap.edgeCount).toBe(0);
  });
});

describe("diffSignalGraphs against live captures", () => {
  afterEach(clearHook);

  it("detects nodes added between two captures", () => {
    const ctl = installHook([
      { id: "s1", name: null, kind: "signal", value: "1", subscribers: [], dependencies: [], evalCount: 0 },
    ]);
    void ctl;
    const before = captureSignalGraph();

    installHook([
      { id: "s1", name: null, kind: "signal", value: "1", subscribers: [], dependencies: [], evalCount: 0 },
      { id: "s2", name: null, kind: "signal", value: "2", subscribers: [], dependencies: [], evalCount: 0 },
    ]);
    const after = captureSignalGraph();

    const diff = diffSignalGraphs(before, after);
    expect(diff.added.map((n) => n.id)).toEqual(["s2"]);
    expect(diff.removed).toHaveLength(0);
  });
});

describe("createTraceProfiler recording", () => {
  let ctl: ReturnType<typeof installHook>;

  beforeEach(() => {
    ctl = installHook();
  });
  afterEach(clearHook);

  it("records effect:create, effect:destroy, and signal:update events", () => {
    const p = createTraceProfiler();
    expect(p.isRecording()).toBe(true);
    // It subscribed to three hook events
    expect(ctl.listenerCount()).toBe(3);

    ctl.emit("effect:create", { name: "myEffect" });
    ctl.emit("effect:destroy", { name: "myEffect" });
    ctl.emit("signal:update", { name: "count", oldValue: 1, newValue: 2 });

    const events = p.stop();
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ name: "myEffect", cat: "effect", ph: "I", tid: 0, pid: 0 });
    expect(events[1]).toMatchObject({ name: "myEffect", cat: "effect" });
    expect(events[2]).toMatchObject({ name: "count", cat: "signal" });
    expect(events[2].args).toEqual({ oldValue: "1", newValue: "2" });

    // After stop, listeners are removed and recording is false
    expect(p.isRecording()).toBe(false);
    expect(ctl.listenerCount()).toBe(0);
  });

  it("uses default names when payloads omit them", () => {
    const p = createTraceProfiler();
    ctl.emit("effect:create", {});
    ctl.emit("effect:destroy", {});
    ctl.emit("signal:update", {}); // no oldValue -> args undefined
    const events = p.stop();
    expect(events[0].name).toBe("effect");
    expect(events[1].name).toBe("effect:destroy");
    expect(events[2].name).toBe("signal");
    expect(events[2].args).toBeUndefined();
  });

  it("does not record events emitted after stop()", () => {
    const p = createTraceProfiler();
    ctl.emit("effect:create", { name: "a" });
    const first = p.stop();
    expect(first).toHaveLength(1);

    // stop() is idempotent and ignores subsequent emits
    ctl.emit("effect:create", { name: "b" });
    expect(p.stop()).toHaveLength(1);
  });

  it("stopTrace returns Chrome tracing JSON with the recorded events", () => {
    const p = createTraceProfiler();
    ctl.emit("effect:create", { name: "traced" });
    const json = p.stopTrace();
    const parsed = JSON.parse(json) as { traceEvents: Array<{ name: string }>; displayTimeUnit: string };
    expect(parsed.displayTimeUnit).toBe("ms");
    expect(parsed.traceEvents.map((e) => e.name)).toContain("traced");
    expect(p.isRecording()).toBe(false);
  });
});
