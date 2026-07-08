import { describe, expect, it } from "vitest";
import { signal } from "../src/core/signals/signal";
import { watch } from "../src/core/signals/watch";

describe("watch", () => {
  it("calls callback when the watched value changes", async () => {
    const [count, setCount] = signal(0);
    const calls: [number, number | undefined][] = [];

    watch(
      () => count(),
      (newVal, oldVal) => {
        calls.push([newVal, oldVal]);
      },
    );

    expect(calls).toEqual([]);

    setCount(5);
    await Promise.resolve();

    expect(calls).toEqual([[5, 0]]);
  });

  it("does not call callback if the value remains the same", async () => {
    const [value, setValue] = signal(10);
    let called = false;

    watch(
      () => value(),
      () => {
        called = true;
      },
    );

    setValue(10);
    await Promise.resolve();

    expect(called).toBe(false);
  });
});
