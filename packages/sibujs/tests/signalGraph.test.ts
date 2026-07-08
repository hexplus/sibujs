import { describe, expect, it } from "vitest";
import { captureSignalGraph, createTraceProfiler, diffSignalGraphs } from "../src/devtools/signalGraph";

describe("captureSignalGraph", () => {
  it("returns an empty snapshot when no dev hook is installed", () => {
    const snap = captureSignalGraph();
    expect(snap).toEqual({
      capturedAt: expect.any(Number),
      nodes: [],
      edgeCount: 0,
    });
  });
});

describe("diffSignalGraphs", () => {
  it("identifies added, removed, and reevaluated nodes", () => {
    const before = {
      capturedAt: 0,
      nodes: [
        { id: "1", name: null, kind: "signal", value: "a", subscribers: [], dependencies: [], evalCount: 1 },
        { id: "2", name: null, kind: "signal", value: "b", subscribers: [], dependencies: [], evalCount: 3 },
      ],
      edgeCount: 0,
    };
    const after = {
      capturedAt: 0,
      nodes: [
        { id: "2", name: null, kind: "signal", value: "b", subscribers: [], dependencies: [], evalCount: 5 },
        { id: "3", name: null, kind: "signal", value: "c", subscribers: [], dependencies: [], evalCount: 1 },
      ],
      edgeCount: 0,
    };
    const diff = diffSignalGraphs(before, after);
    expect(diff.added.map((n) => n.id)).toEqual(["3"]);
    expect(diff.removed.map((n) => n.id)).toEqual(["1"]);
    expect(diff.reevaluated.map((n) => n.id)).toEqual(["2"]);
  });
});

describe("createTraceProfiler", () => {
  it("returns a handle even without a dev hook", () => {
    const p = createTraceProfiler();
    expect(typeof p.stop).toBe("function");
    expect(typeof p.stopTrace).toBe("function");
    const events = p.stop();
    expect(Array.isArray(events)).toBe(true);
  });

  it("stopTrace returns valid JSON with a traceEvents array", () => {
    const p = createTraceProfiler();
    const json = p.stopTrace();
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed.traceEvents)).toBe(true);
  });
});
