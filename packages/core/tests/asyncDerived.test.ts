import { describe, expect, it } from "vitest";
import { asyncDerived } from "../src/core/signals/asyncDerived";
import { signal } from "../src/core/signals/signal";

function flushMicrotasks() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("asyncDerived", () => {
  it("seeds with initial value and resolves with async result", async () => {
    const d = asyncDerived(async () => "done", "loading");
    expect(d.value()).toBe("loading");
    expect(d.loading()).toBe(true);
    await flushMicrotasks();
    expect(d.value()).toBe("done");
    expect(d.loading()).toBe(false);
    expect(d.error()).toBe(null);
  });

  it("captures errors into the error signal", async () => {
    const d = asyncDerived(async () => {
      throw new Error("boom");
    }, "x");
    await flushMicrotasks();
    expect(d.loading()).toBe(false);
    expect(d.error()).toBeInstanceOf(Error);
  });

  it("re-runs when a reactive dependency changes", async () => {
    const [q, setQ] = signal("a");
    const d = asyncDerived(async () => `result:${q()}`, "");
    await flushMicrotasks();
    expect(d.value()).toBe("result:a");
    setQ("b");
    await flushMicrotasks();
    expect(d.value()).toBe("result:b");
  });

  it("drops stale results when dependencies change rapidly", async () => {
    const [q, setQ] = signal("a");
    let resolveA: (v: string) => void = () => {};
    let resolveB: (v: string) => void = () => {};

    const d = asyncDerived(async () => {
      const current = q();
      return new Promise<string>((resolve) => {
        if (current === "a") resolveA = resolve;
        else resolveB = resolve;
      });
    }, "");

    // First run is pending for "a"
    setQ("b");
    await flushMicrotasks();
    // Now both runs are pending; resolve "a" first (the stale one)
    resolveA("stale");
    await flushMicrotasks();
    expect(d.value()).toBe(""); // stale update ignored
    // Resolve "b" — current result
    resolveB("fresh");
    await flushMicrotasks();
    expect(d.value()).toBe("fresh");
  });

  it("refresh() triggers a re-run", async () => {
    let callCount = 0;
    const d = asyncDerived(async () => {
      callCount++;
      return callCount;
    }, 0);
    await flushMicrotasks();
    expect(d.value()).toBe(1);
    d.refresh();
    await flushMicrotasks();
    expect(d.value()).toBe(2);
  });
});
