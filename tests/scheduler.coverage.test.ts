import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushScheduler, Priority, pendingTasks, scheduleUpdate, yieldToMain } from "../src/performance/scheduler";

afterEach(() => {
  // Drain anything left so tests do not bleed into each other.
  flushScheduler();
  vi.unstubAllGlobals();
});

describe("scheduler frame scheduling (requestAnimationFrame)", () => {
  it("runs NORMAL tasks via the queued animation frame", () => {
    let rafCb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 7;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const fn = vi.fn();
    scheduleUpdate(Priority.NORMAL, fn);
    expect(fn).not.toHaveBeenCalled();
    expect(rafCb).toBeTypeOf("function");

    rafCb?.(0);
    expect(fn).toHaveBeenCalledOnce();
    expect(pendingTasks()).toBe(0);
  });
});

describe("scheduler microtask scheduling (USER_BLOCKING)", () => {
  it("runs USER_BLOCKING tasks via a microtask", async () => {
    const fn = vi.fn();
    scheduleUpdate(Priority.USER_BLOCKING, fn);
    expect(fn).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe("scheduler idle scheduling", () => {
  it("uses requestIdleCallback for IDLE tasks when available", () => {
    let idleCb: (() => void) | null = null;
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
      idleCb = cb;
      return 11;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    const fn = vi.fn();
    scheduleUpdate(Priority.IDLE, fn);
    expect(idleCb).toBeTypeOf("function");
    idleCb?.();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("falls back to setTimeout for IDLE tasks when requestIdleCallback is missing", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);

    const fn = vi.fn();
    scheduleUpdate(Priority.IDLE, fn);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60);
    expect(fn).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

describe("flushScheduler cancellation branches", () => {
  it("cancels a pending animation frame on flush", () => {
    const cancelRaf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", () => 42);
    vi.stubGlobal("cancelAnimationFrame", cancelRaf);

    const fn = vi.fn();
    scheduleUpdate(Priority.NORMAL, fn);
    flushScheduler();
    expect(cancelRaf).toHaveBeenCalledWith(42);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("cancels a pending idle callback on flush", () => {
    const cancelIdle = vi.fn();
    vi.stubGlobal("requestIdleCallback", () => 99);
    vi.stubGlobal("cancelIdleCallback", cancelIdle);

    const fn = vi.fn();
    scheduleUpdate(Priority.IDLE, fn);
    flushScheduler();
    expect(cancelIdle).toHaveBeenCalledWith(99);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("clears a pending timeout on flush when idle fallback was used", () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const fn = vi.fn();
    scheduleUpdate(Priority.IDLE, fn);
    // The fallback registered a setTimeout handle; flush should clear it.
    flushScheduler();
    expect(fn).toHaveBeenCalledOnce();
    expect(pendingTasks()).toBe(0);
  });
});

describe("scheduler error handling", () => {
  it("logs and continues when a queued task throws during processQueue", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let rafCb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const good = vi.fn();
    scheduleUpdate(Priority.NORMAL, () => {
      throw new Error("boom");
    });
    scheduleUpdate(Priority.NORMAL, good);
    // processQueue (driven by the frame callback) catches and logs task errors.
    rafCb?.(0);
    expect(good).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("logs when an IMMEDIATE task throws", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    scheduleUpdate(Priority.IMMEDIATE, () => {
      throw new Error("immediate boom");
    });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("yieldToMain with scheduler.yield", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("delegates to scheduler.yield when present", async () => {
    const yieldFn = vi.fn(() => Promise.resolve());
    vi.stubGlobal("scheduler", { yield: yieldFn });
    await yieldToMain();
    expect(yieldFn).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("falls back to setTimeout when scheduler.yield is absent", async () => {
    vi.stubGlobal("scheduler", undefined);
    await expect(yieldToMain()).resolves.toBeUndefined();
  });
});
