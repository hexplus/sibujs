import { describe, expect, it } from "vitest";
import { derived } from "../src/core/signals/derived";
import { signal } from "../src/core/signals/signal";

describe("derived", () => {
  it("should derive new values when dependencies change", async () => {
    const [a, setA] = signal(1);
    const [b, setB] = signal(2);

    const sum = derived(() => a() + b());

    expect(sum()).toBe(3);

    setA(5);

    await Promise.resolve();

    expect(sum()).toBe(7);

    setB(10);
    await Promise.resolve();
    expect(sum()).toBe(15);
  });

  it("should not notify subscribers if value didn’t change", async () => {
    const [x, setX] = signal(3);
    let calls = 0;

    const doubleX = derived(() => x() * 2);

    const subscriber = () => calls++;

    doubleX();

    (doubleX as unknown as { _subscribers?: Set<() => void> })._subscribers?.add(subscriber);

    setX(3);
    await Promise.resolve();

    expect(calls).toBe(0);
  });

  it("applies custom equals even when the previous value is undefined", () => {
    const [n, setN] = signal(0);
    let equalsCalls = 0;
    // The getter legitimately produces `undefined`. The previous gating on
    // `_v !== undefined` skipped `equals` here, causing spurious version bumps.
    const d = derived(() => (n() < 0 ? 1 : undefined), {
      equals: (a, b) => {
        equalsCalls++;
        return a === b;
      },
    });

    expect(d()).toBeUndefined(); // initial eval
    setN(1); // still undefined under the getter
    expect(d()).toBeUndefined();
    // equals must have been consulted on the recompute (prev was undefined).
    expect(equalsCalls).toBeGreaterThan(0);
  });
});
