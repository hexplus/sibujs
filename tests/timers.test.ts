import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interval, timeout } from "../src/ui/timers";

describe("interval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls the callback every `ms` milliseconds", () => {
    const fn = vi.fn();
    const h = interval(fn, 100);
    vi.advanceTimersByTime(350);
    expect(fn).toHaveBeenCalledTimes(3);
    h.stop();
  });

  it("stop prevents future ticks and is idempotent", () => {
    const fn = vi.fn();
    const h = interval(fn, 100);
    h.stop();
    h.stop();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(0);
    expect(h.isRunning()).toBe(false);
  });

  it("pause and resume toggle the running state", () => {
    const fn = vi.fn();
    const h = interval(fn, 100);
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(2);
    h.pause();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(2);
    h.resume();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(3);
    h.stop();
  });
});

describe("timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires after the specified delay", () => {
    const fn = vi.fn();
    const h = timeout(fn, 500);
    expect(h.isPending()).toBe(true);
    vi.advanceTimersByTime(499);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(h.isPending()).toBe(false);
  });

  it("cancel prevents firing", () => {
    const fn = vi.fn();
    const h = timeout(fn, 500);
    h.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
    expect(h.isPending()).toBe(false);
  });
});
