import { describe, expect, it } from "vitest";
import { signal } from "../src/core/signals/signal";
import { strict, strictEffect } from "../src/core/strict";

function flushMicro() {
  return new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("strict", () => {
  it("runs the body twice in dev mode", async () => {
    let count = 0;
    strict(() => {
      count++;
    });
    expect(count).toBe(1);
    await flushMicro();
    expect(count).toBe(2);
  });

  it("returns the result of the first invocation", () => {
    const result = strict(() => 42);
    expect(result).toBe(42);
  });

  it("swallows exceptions from the second run", async () => {
    let count = 0;
    strict(() => {
      count++;
      if (count === 2) throw new Error("boom");
    });
    await flushMicro();
    expect(count).toBe(2);
    // No exception propagates
  });
});

describe("strictEffect", () => {
  it("re-runs the effect body to surface cleanup bugs", async () => {
    const [value, setValue] = signal(0);
    let runs = 0;
    const dispose = strictEffect(() => {
      value();
      runs++;
    });
    // First run is synchronous
    expect(runs).toBe(1);
    // Second run scheduled on microtask
    await flushMicro();
    // strictEffect registers a SECOND effect() that reads value() again,
    // so both effects run: 1 from first + 1 from second = 2.
    expect(runs).toBe(2);

    // When value changes, both effects re-run
    setValue(1);
    expect(runs).toBe(4);
    dispose();
  });

  it("returns a teardown that disposes both effects", async () => {
    const [value, setValue] = signal("a");
    let runs = 0;
    const dispose = strictEffect(() => {
      value();
      runs++;
    });
    await flushMicro();
    const before = runs;
    dispose();
    setValue("b");
    // No further runs after teardown
    expect(runs).toBe(before);
  });
});
