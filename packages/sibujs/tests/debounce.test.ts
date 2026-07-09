import { signal } from "@sibujs/core";
import { describe, expect, it, vi } from "vitest";
import { debounce } from "../src/data/debounce";

describe("debounce", () => {
  it("returns the initial value immediately", () => {
    const [count] = signal(42);
    const debounced = debounce(count, 100);
    expect(debounced()).toBe(42);
  });

  it("does not update during the delay period", async () => {
    vi.useFakeTimers();
    const [count, setCount] = signal(0);
    const debounced = debounce(count, 100);

    setCount(5);
    await Promise.resolve();

    vi.advanceTimersByTime(50);
    expect(debounced()).toBe(0); // not yet updated

    vi.useRealTimers();
  });

  it("updates after the delay period expires", async () => {
    vi.useFakeTimers();
    const [count, setCount] = signal(0);
    const debounced = debounce(count, 100);

    setCount(5);
    await Promise.resolve();

    vi.advanceTimersByTime(100);
    expect(debounced()).toBe(5);

    vi.useRealTimers();
  });

  it("resets the timer on rapid successive changes", async () => {
    vi.useFakeTimers();
    const [count, setCount] = signal(0);
    const debounced = debounce(count, 100);

    setCount(1);
    await Promise.resolve();
    vi.advanceTimersByTime(50);

    setCount(2);
    await Promise.resolve();
    vi.advanceTimersByTime(50);

    setCount(3);
    await Promise.resolve();
    vi.advanceTimersByTime(50);

    // Only 50ms since last change, should still be 0
    expect(debounced()).toBe(0);

    vi.advanceTimersByTime(50);
    // Now 100ms since last change (3), should update
    expect(debounced()).toBe(3);

    vi.useRealTimers();
  });

  it("works with string values", async () => {
    vi.useFakeTimers();
    const [text, setText] = signal("hello");
    const debounced = debounce(text, 200);

    expect(debounced()).toBe("hello");

    setText("world");
    await Promise.resolve();
    vi.advanceTimersByTime(200);

    expect(debounced()).toBe("world");

    vi.useRealTimers();
  });

  it("does not update if value stays the same", async () => {
    vi.useFakeTimers();
    const [count, setCount] = signal(5);
    const debounced = debounce(count, 100);

    setCount(5); // same value — signal won't notify
    await Promise.resolve();
    vi.advanceTimersByTime(100);

    expect(debounced()).toBe(5);

    vi.useRealTimers();
  });

  it("dispose() stops the subscription and cancels the pending timer", async () => {
    vi.useFakeTimers();
    const [count, setCount] = signal(0);
    const debounced = debounce(count, 100) as (() => number) & { dispose: () => void };
    expect(typeof debounced.dispose).toBe("function");

    setCount(1);
    await Promise.resolve();
    debounced.dispose(); // cancels the pending timer + stops tracking

    vi.advanceTimersByTime(200);
    expect(debounced()).toBe(0); // pending update was cancelled

    setCount(2);
    await Promise.resolve();
    vi.advanceTimersByTime(200);
    expect(debounced()).toBe(0); // no longer tracking the source

    vi.useRealTimers();
  });
});
