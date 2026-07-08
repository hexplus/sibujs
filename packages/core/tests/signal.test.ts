import { describe, expect, it } from "vitest";
import { signal } from "../src/core/signals/signal";

describe("signal", () => {
  it("should return initial value", () => {
    const [count] = signal(5);
    expect(count()).toBe(5);
  });

  it("should update the value", () => {
    const [count, setCount] = signal(2);
    setCount(10);
    expect(count()).toBe(10);
  });

  it("should accept updater function", () => {
    const [count, setCount] = signal(1);
    setCount((prev) => prev + 1);
    expect(count()).toBe(2);
  });
});
