import { describe, expect, it, vi } from "vitest";
import { calculateDelay, withRetry } from "../src/data/retry";

describe("calculateDelay", () => {
  it("calculates exponential backoff", () => {
    expect(calculateDelay(0, "exponential", 1000, 30000, 0)).toBe(1000);
    expect(calculateDelay(1, "exponential", 1000, 30000, 0)).toBe(2000);
    expect(calculateDelay(2, "exponential", 1000, 30000, 0)).toBe(4000);
    expect(calculateDelay(3, "exponential", 1000, 30000, 0)).toBe(8000);
  });

  it("calculates linear backoff", () => {
    expect(calculateDelay(0, "linear", 1000, 30000, 0)).toBe(1000);
    expect(calculateDelay(1, "linear", 1000, 30000, 0)).toBe(2000);
    expect(calculateDelay(2, "linear", 1000, 30000, 0)).toBe(3000);
  });

  it("calculates fixed delay", () => {
    expect(calculateDelay(0, "fixed", 1000, 30000, 0)).toBe(1000);
    expect(calculateDelay(1, "fixed", 1000, 30000, 0)).toBe(1000);
    expect(calculateDelay(5, "fixed", 1000, 30000, 0)).toBe(1000);
  });

  it("caps delay at maxDelay", () => {
    expect(calculateDelay(10, "exponential", 1000, 5000, 0)).toBe(5000);
  });

  it("applies jitter within bounds", () => {
    const results = new Set<number>();
    for (let i = 0; i < 50; i++) {
      results.add(calculateDelay(0, "fixed", 1000, 30000, 0.5));
    }
    for (const d of results) {
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(1500);
    }
  });

  it("never returns negative delay", () => {
    const result = calculateDelay(0, "fixed", 1, 1, 1);
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

describe("withRetry", () => {
  it("succeeds on first attempt", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries on failure and succeeds", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(new Error("fail1")).mockResolvedValue("ok");

    const promise = withRetry(fn, { baseDelay: 100, jitter: 0 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("throws after maxRetries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fail"));

    await expect(withRetry(fn, { maxRetries: 2, baseDelay: 0, jitter: 0 })).rejects.toThrow("always fail");

    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("respects shouldRetry predicate", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("non-retryable"));

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow("non-retryable");

    expect(fn).toHaveBeenCalledOnce(); // no retries
  });

  it("calls onRetry callback", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValue("ok");
    const onRetry = vi.fn();

    const promise = withRetry(fn, { baseDelay: 100, jitter: 0 }, onRetry);
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 0, 100);
    vi.useRealTimers();
  });

  it("respects AbortSignal", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    const promise = withRetry(fn, { maxRetries: 5, baseDelay: 1000 }, undefined, controller.signal);
    controller.abort();

    await expect(promise).rejects.toThrow();
  });

  it("throws immediately if already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn();

    await expect(withRetry(fn, undefined, undefined, controller.signal)).rejects.toThrow();

    expect(fn).not.toHaveBeenCalled();
  });
});
