// Regression test for round-9 fix: a disposed reactiveBinding must not run or
// re-subscribe if its run is drained after disposal (zombie resurrection).
import { describe, expect, it } from "vitest";
import { signal } from "../src/core/signals/signal";
import { reactiveBinding } from "../src/reactivity/track";

describe("reactiveBinding: disposed binding does not resurrect", () => {
  it("a binding disposed mid-drain neither runs nor re-subscribes", () => {
    const [s, setS] = signal(0);
    let cRuns = 0;

    // C subscribes first (so the most-recently-subscribed P sits at the list
    // head and drains BEFORE C). When P runs and sees s===1 it disposes C —
    // while C is still queued in the same drain.
    const disposeC = reactiveBinding(() => {
      s();
      cRuns++;
    });
    reactiveBinding(() => {
      if (s() === 1) disposeC();
    });

    expect(cRuns).toBe(1); // initial run

    setS(1); // P drains first, disposes C; C's queued run must be skipped
    expect(cRuns).toBe(1);

    setS(2); // C must stay disposed (not resurrected via a re-subscribed edge)
    expect(cRuns).toBe(1);
  });

  it("an explicitly disposed binding stops reacting", () => {
    const [s, setS] = signal(0);
    let runs = 0;
    const dispose = reactiveBinding(() => {
      s();
      runs++;
    });
    expect(runs).toBe(1);
    dispose();
    setS(1);
    expect(runs).toBe(1);
  });
});
