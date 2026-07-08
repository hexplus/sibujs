import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkLeaks,
  clearPerformanceData,
  debugLog,
  disableDebug,
  enableDebug,
  getPerformanceReport,
  isDebugEnabled,
  measureRender,
  perfTracker,
  trackCleanup,
} from "../src/devtools/debug";

describe("Debug mode", () => {
  beforeEach(() => {
    disableDebug();
    clearPerformanceData();
  });

  it("should toggle debug mode", () => {
    expect(isDebugEnabled()).toBe(false);
    enableDebug();
    expect(isDebugEnabled()).toBe(true);
    disableDebug();
    expect(isDebugEnabled()).toBe(false);
  });

  it("should log only when debug enabled", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    debugLog("Test", "action");
    expect(spy).not.toHaveBeenCalled();

    enableDebug();
    debugLog("Test", "action");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("performance", () => {
  beforeEach(() => clearPerformanceData());

  it("should measure render time", () => {
    const perf = perfTracker("TestComponent");
    perf.startMeasure();
    // Simulate some work
    perf.endMeasure();

    expect(perf.getRenderCount()).toBe(1);
    expect(perf.getAverageTime()).toBeGreaterThanOrEqual(0);
  });

  it("should generate performance report", () => {
    const perf = perfTracker("Widget");
    perf.startMeasure();
    perf.endMeasure();
    perf.startMeasure();
    perf.endMeasure();

    const report = getPerformanceReport();
    expect(report["Widget"]).toBeDefined();
    expect(report["Widget"].count).toBe(2);
  });
});

describe("measureRender", () => {
  beforeEach(() => clearPerformanceData());

  it("should wrap and measure a component", () => {
    const MyComp = (props: { text: string }) => {
      const el = document.createElement("div");
      el.textContent = props.text;
      return el;
    };

    const Measured = measureRender("MyComp", MyComp);
    const el = Measured({ text: "hello" });
    expect(el.textContent).toBe("hello");

    const report = getPerformanceReport();
    expect(report["MyComp"].count).toBe(1);
  });
});

describe("checkLeaks", () => {
  it("should detect tracked cleanups", () => {
    trackCleanup("LeakyComponent", () => {});
    trackCleanup("LeakyComponent", () => {});

    const leaks = checkLeaks();
    expect(leaks["LeakyComponent"]).toBe(2);
  });
});
