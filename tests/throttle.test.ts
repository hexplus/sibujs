import { describe, expect, it, vi } from "vitest";
import { signal } from "../src/core/signals/signal";
import { throttle } from "../src/data/throttle";

describe("throttle", () => {
  it("returns the initial value immediately", () => {
    const [count] = signal(42);
    const throttled = throttle(count, 100);
    expect(throttled()).toBe(42);
  });

  it("allows the first update immediately (leading edge)", () => {
    const [count, setCount] = signal(0);
    const throttled = throttle(count, 100);

    setCount(5);
    // Leading edge: should update synchronously
    expect(throttled()).toBe(5);
  });

  it("defers updates during cooldown", () => {
    vi.useFakeTimers();
    const [count, setCount] = signal(0);
    const throttled = throttle(count, 100);

    setCount(1); // leading edge
    expect(throttled()).toBe(1);

    setCount(2); // during cooldown — deferred
    expect(throttled()).toBe(1);

    setCount(3); // during cooldown — deferred (overwrites 2)
    expect(throttled()).toBe(1);

    vi.useRealTimers();
  });

  it("propagates trailing edge value when cooldown ends", () => {
    vi.useFakeTimers();
    const [count, setCount] = signal(0);
    const throttled = throttle(count, 100);

    setCount(1); // leading edge
    expect(throttled()).toBe(1);

    setCount(2); // deferred
    setCount(3); // deferred (latest)

    vi.advanceTimersByTime(100); // cooldown ends, trailing fires
    expect(throttled()).toBe(3);

    vi.useRealTimers();
  });

  it("allows a new leading edge after cooldown", () => {
    vi.useFakeTimers();
    const [count, setCount] = signal(0);
    const throttled = throttle(count, 100);

    setCount(1); // leading edge
    expect(throttled()).toBe(1);

    vi.advanceTimersByTime(100); // cooldown ends (no trailing — no pending)
    expect(throttled()).toBe(1);

    setCount(5); // new leading edge
    expect(throttled()).toBe(5);

    vi.useRealTimers();
  });

  it("does not fire trailing edge if no changes during cooldown", () => {
    vi.useFakeTimers();
    const [count, setCount] = signal(0);
    const throttled = throttle(count, 100);

    setCount(1); // leading edge
    expect(throttled()).toBe(1);

    // No further changes during cooldown
    vi.advanceTimersByTime(100);
    expect(throttled()).toBe(1); // no trailing update

    vi.useRealTimers();
  });

  it("works with string values", () => {
    vi.useFakeTimers();
    const [text, setText] = signal("a");
    const throttled = throttle(text, 100);

    setText("b"); // leading edge
    expect(throttled()).toBe("b");

    setText("c"); // deferred
    vi.advanceTimersByTime(100);
    expect(throttled()).toBe("c"); // trailing edge

    vi.useRealTimers();
  });

  it("dispose() stops the subscription and clears the cooldown timer", async () => {
    vi.useFakeTimers();
    const [n, setN] = signal(0);
    const throttled = throttle(n, 100) as (() => number) & { dispose: () => void };
    expect(typeof throttled.dispose).toBe("function");

    setN(1);
    await Promise.resolve();
    expect(throttled()).toBe(1); // leading edge fired

    throttled.dispose();
    setN(2);
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(throttled()).toBe(1); // no further updates after dispose

    vi.useRealTimers();
  });
});
