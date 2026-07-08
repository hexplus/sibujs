import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateDelay, withRetry } from "../src/data/retry";

describe("calculateDelay (coverage)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("computes exponential backoff with no jitter", () => {
    expect(calculateDelay(0, "exponential", 1000, 30000, 0)).toBe(1000);
    expect(calculateDelay(1, "exponential", 1000, 30000, 0)).toBe(2000);
    expect(calculateDelay(2, "exponential", 1000, 30000, 0)).toBe(4000);
    expect(calculateDelay(3, "exponential", 1000, 30000, 0)).toBe(8000);
  });

  it("computes linear backoff with no jitter", () => {
    expect(calculateDelay(0, "linear", 1000, 30000, 0)).toBe(1000);
    expect(calculateDelay(1, "linear", 1000, 30000, 0)).toBe(2000);
    expect(calculateDelay(2, "linear", 1000, 30000, 0)).toBe(3000);
  });

  it("computes fixed backoff with no jitter", () => {
    expect(calculateDelay(0, "fixed", 500, 30000, 0)).toBe(500);
    expect(calculateDelay(5, "fixed", 500, 30000, 0)).toBe(500);
  });

  it("caps the delay at maxDelay", () => {
    // exponential would be 1000 * 2^20 ≈ 1 billion, capped to 5000
    expect(calculateDelay(20, "exponential", 1000, 5000, 0)).toBe(5000);
  });

  it("applies jitter within the expected range", () => {
    const values = new Set<number>();
    for (let i = 0; i < 50; i++) {
      const d = calculateDelay(0, "fixed", 1000, 30000, 0.5);
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(1500);
      values.add(d);
    }
    expect(values.size).toBeGreaterThan(1);
  });

  it("jitter at the extremes is deterministic with mocked Math.random", () => {
    // Math.random() = 0 => factor (0*2-1) = -1 => delay - jitterRange
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(calculateDelay(0, "fixed", 1000, 30000, 0.1)).toBe(900);

    // Math.random() = 1 => factor (1*2-1) = +1 => delay + jitterRange
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(calculateDelay(0, "fixed", 1000, 30000, 0.1)).toBeCloseTo(1100, 5);
  });

  it("guards against non-finite delay (Infinity) before jitter", () => {
    const d = calculateDelay(2000, "exponential", 1000, Number.POSITIVE_INFINITY, 0);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThanOrEqual(0);
  });

  it("guards against NaN producing immediate fire", () => {
    const d = calculateDelay(1000, "exponential", Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 0.1);
    expect(Number.isNaN(d)).toBe(false);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeGreaterThanOrEqual(0);
  });

  it("never returns a negative delay even with oversized jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(calculateDelay(0, "fixed", 1000, 30000, 5)).toBe(0);
  });
});

describe("withRetry (coverage)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the result on first success without retrying", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await withRetry(fn, { maxRetries: 3 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until success then resolves", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "recovered";
    });

    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 0, jitter: 0 });
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after exhausting retries", async () => {
    const fn = vi.fn(async () => {
      throw new Error("always fails");
    });

    await expect(withRetry(fn, { maxRetries: 2, baseDelay: 0, jitter: 0 })).rejects.toThrow("always fails");
    // initial attempt + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry when maxRetries is 0", async () => {
    const fn = vi.fn(async () => {
      throw new Error("nope");
    });

    await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects shouldRetry predicate (stops early)", async () => {
    const fn = vi.fn(async () => {
      throw new TypeError("not retryable");
    });
    const shouldRetry = vi.fn((err: unknown) => !(err instanceof TypeError));

    await expect(withRetry(fn, { maxRetries: 5, baseDelay: 0, shouldRetry })).rejects.toThrow("not retryable");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it("invokes onRetry with error, attempt, and delay", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) throw new Error(`fail-${calls}`);
      return "done";
    };
    const onRetry = vi.fn();

    await withRetry(fn, { maxRetries: 3, strategy: "fixed", baseDelay: 0, jitter: 0 }, onRetry);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, expect.any(Error), 0, 0);
    expect(onRetry).toHaveBeenNthCalledWith(2, expect.any(Error), 1, 0);
  });

  it("throws AbortError immediately if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => "should not run");

    await expect(withRetry(fn, { maxRetries: 3 }, undefined, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it("aborts during the backoff wait and rejects with AbortError", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      throw new Error("transient");
    });

    const promise = withRetry(
      fn,
      { maxRetries: 5, strategy: "fixed", baseDelay: 1000, jitter: 0 },
      undefined,
      controller.signal,
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });

    // Let the first attempt fail and enter the backoff wait.
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("clears the backoff timer when aborted (no lingering timers)", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fn = async () => {
      throw new Error("transient");
    };

    const promise = withRetry(
      fn,
      { maxRetries: 5, strategy: "fixed", baseDelay: 5000, jitter: 0 },
      undefined,
      controller.signal,
    );
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits the calculated delay between retries", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return "ok";
    });

    const promise = withRetry(fn, { maxRetries: 3, strategy: "fixed", baseDelay: 1000, jitter: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("uses default options when none are provided", async () => {
    const fn = vi.fn(async () => "default-ok");
    const result = await withRetry(fn);
    expect(result).toBe("default-ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
