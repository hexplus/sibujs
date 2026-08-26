import { describe, expect, it, vi } from "vitest";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";

describe("REPRO: large finite cascade must not be flagged as a cycle", () => {
  it("60-step legitimate cascade", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const N = 60;
    const sigs = Array.from({ length: N }, () => signal(0));
    const disposers: Array<() => void> = [];

    // Chain: effect i reads sigs[i], writes sigs[i+1]. Finite, terminating.
    for (let i = 0; i < N - 1; i++) {
      disposers.push(
        effect(() => {
          const v = sigs[i][0]();
          sigs[i + 1][1](v);
        }),
      );
    }

    // Sink reads every signal in the chain -> re-runs once per link update.
    let sinkRuns = 0;
    disposers.push(
      effect(() => {
        for (let i = 0; i < N; i++) sigs[i][0]();
        sinkRuns++;
      }),
    );

    const baseline = sinkRuns;
    sigs[0][1](1); // kick off the cascade

    const finalValue = sigs[N - 1][0]();
    console.log("cycleErrors:", spy.mock.calls.length, "sinkRuns:", sinkRuns - baseline, "final:", finalValue);

    // The cascade is finite and must fully propagate.
    expect(finalValue).toBe(1);
    expect(spy.mock.calls.length).toBe(0);
    spy.mockRestore();
    for (const d of disposers) d();
  });
});
