import { describe, expect, it, vi } from "vitest";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { batch } from "../src/reactivity/batch";

describe("REPRO scheduler isolation: mutual loop", () => {
  it("mutual A<->B loop must not discard unrelated pending effect C", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    const [c, setC] = signal(0);
    let cRuns = 0;

    // A reads a, writes b. B reads b, writes a. Mutual cycle through the drain.
    const dA = effect(() => {
      setB(a() + 1);
    });
    const dB = effect(() => {
      setA(b() + 1);
    });
    // Unrelated effect subscribed LAST, so it is enqueued AFTER the cycle pair.
    const dC = effect(() => {
      c();
      cRuns++;
    });

    const baseline = cRuns;

    batch(() => {
      setA(100);
      setC(1);
    });

    // eslint-disable-next-line no-console
    console.log("cycle errors:", spy.mock.calls.length, "cRuns delta:", cRuns - baseline);
    expect(cRuns).toBe(baseline + 1);
    spy.mockRestore();
    dA();
    dB();
    dC();
  });
});
