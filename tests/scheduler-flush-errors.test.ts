import { afterEach, describe, expect, it, vi } from "vitest";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { flushScheduler, Priority, pendingTasks, scheduleUpdate } from "../src/performance/scheduler";
import { callbackSlot } from "./helpers/mocks";

// ---------------------------------------------------------------------------
// A throwing task must not strand the rest of the scheduler queue.
//
// THE DEFECT: flushScheduler() cancelled the pending frame/idle/timeout wake-up
// and then invoked callbacks with no try/catch. The first throw escaped, the
// loop aborted, and every later task stayed queued with nothing scheduled to
// run it. The async processQueue() did contain failures, but logged them with
// console.error instead of the runtime error pipeline.
// ---------------------------------------------------------------------------

type Report = { error: unknown; context: RuntimeErrorContext };

function captureReports(): Report[] {
  const reports: Report[] = [];
  setRuntimeErrorHandler((error, context) => reports.push({ error, context }));
  return reports;
}

afterEach(() => {
  setRuntimeErrorHandler(null);
  flushScheduler();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("flushScheduler() with a throwing task", () => {
  it("runs throwing → valid → valid: both valid tasks execute and the queue drains", () => {
    const reports = captureReports();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const boom = new Error("boom");
    const first = vi.fn();
    const second = vi.fn();

    scheduleUpdate(Priority.NORMAL, () => {
      throw boom;
    });
    scheduleUpdate(Priority.NORMAL, first);
    scheduleUpdate(Priority.NORMAL, second);

    expect(() => flushScheduler()).not.toThrow();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(pendingTasks()).toBe(0);
    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBe(boom);
    expect(reports[0].context.phase).toBe("scheduler");
  });

  it("reports every failing task once and keeps the scheduler usable", () => {
    const reports = captureReports();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    scheduleUpdate(Priority.NORMAL, () => {
      throw new Error("one");
    });
    scheduleUpdate(Priority.LOW, () => {
      throw new Error("two");
    });
    flushScheduler();
    expect(reports.map((r) => (r.error as Error).message)).toEqual(["one", "two"]);

    const later = vi.fn();
    scheduleUpdate(Priority.NORMAL, later);
    flushScheduler();
    expect(later).toHaveBeenCalledOnce();
    expect(pendingTasks()).toBe(0);
  });
});

describe("processQueue() and IMMEDIATE tasks use the runtime error pipeline", () => {
  it("a throwing frame task is reported with phase scheduler and the next task still runs", () => {
    const reports = captureReports();
    const rafCb = callbackSlot<FrameRequestCallback>("rafCb");
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCb.set(cb);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Pin the time slice so the drain is not cut short on a slow machine.
    vi.spyOn(performance, "now").mockReturnValue(0);

    const good = vi.fn();
    scheduleUpdate(Priority.NORMAL, () => {
      throw new Error("frame boom");
    });
    scheduleUpdate(Priority.NORMAL, good);
    rafCb.invoke(0);

    expect(good).toHaveBeenCalledOnce();
    expect(reports).toHaveLength(1);
    expect(reports[0].context.phase).toBe("scheduler");
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("a throwing IMMEDIATE task is reported with phase scheduler", () => {
    const reports = captureReports();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    scheduleUpdate(Priority.IMMEDIATE, () => {
      throw new Error("immediate boom");
    });

    expect(reports).toHaveLength(1);
    expect((reports[0].error as Error).message).toBe("immediate boom");
    expect(reports[0].context.phase).toBe("scheduler");
    expect(errSpy).not.toHaveBeenCalled();
  });
});
