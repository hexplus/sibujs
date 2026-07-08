import { describe, expect, it, vi } from "vitest";
import { createProfiler, startMeasure } from "../src/devtools/componentProfiler";

describe("componentProfiler", () => {
  it("initializes with zero values", () => {
    const profiler = createProfiler("TestComponent");

    expect(profiler.renderCount()).toBe(0);
    expect(profiler.lastRenderTime()).toBe(0);
    expect(profiler.averageRenderTime()).toBe(0);
    expect(profiler.totalRenderTime()).toBe(0);
  });

  it("records render measurements via startMeasure", () => {
    // Mock performance.now to return controlled values
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const profiler = createProfiler("TestComponent");

    const stop = startMeasure(profiler);
    now = 1010; // 10ms elapsed
    stop();

    expect(profiler.renderCount()).toBe(1);
    expect(profiler.lastRenderTime()).toBe(10);
    expect(profiler.totalRenderTime()).toBe(10);
    expect(profiler.averageRenderTime()).toBe(10);

    vi.restoreAllMocks();
  });

  it("tracks multiple renders and computes averages", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const profiler = createProfiler("MultiRender");

    // First render: 10ms
    now = 100;
    const stop1 = startMeasure(profiler);
    now = 110;
    stop1();

    // Second render: 20ms
    now = 200;
    const stop2 = startMeasure(profiler);
    now = 220;
    stop2();

    // Third render: 30ms
    now = 300;
    const stop3 = startMeasure(profiler);
    now = 330;
    stop3();

    expect(profiler.renderCount()).toBe(3);
    expect(profiler.totalRenderTime()).toBe(60);
    expect(profiler.averageRenderTime()).toBe(20);
    expect(profiler.lastRenderTime()).toBe(30);

    vi.restoreAllMocks();
  });

  it("reset clears all profiler state", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const profiler = createProfiler("Resettable");

    now = 0;
    const stop = startMeasure(profiler);
    now = 5;
    stop();

    expect(profiler.renderCount()).toBe(1);

    profiler.reset();

    expect(profiler.renderCount()).toBe(0);
    expect(profiler.lastRenderTime()).toBe(0);
    expect(profiler.totalRenderTime()).toBe(0);
    expect(profiler.averageRenderTime()).toBe(0);

    vi.restoreAllMocks();
  });

  it("averageRenderTime returns 0 when no renders recorded", () => {
    const profiler = createProfiler("Empty");
    expect(profiler.averageRenderTime()).toBe(0);
  });
});
