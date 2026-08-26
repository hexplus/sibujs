import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { batch } from "../src/reactivity/batch";
import { setMaxDrainIterations, setMaxSubscriberRepeats } from "../src/reactivity/track";

// ---------------------------------------------------------------------------
// Scheduler runaway isolation.
//
// THE INVARIANT UNDER TEST: one pathological subscriber cannot corrupt
// unrelated work. The cycle ceiling must quarantine the offender, not abort the
// whole drain — and it must not misfire on a legitimate deep cascade.
//
// Regression origin: exceeding the per-subscriber repeat ceiling `break`ed the
// drain loop, discarding every subscriber still queued behind the offender. A
// legitimate 60-link cascade tripped the (then 50-run) ceiling and terminated
// half-propagated, leaving the untouched tail holding WRONG values.
// ---------------------------------------------------------------------------

afterEach(() => {
  setMaxSubscriberRepeats(1000);
  setMaxDrainIterations(1_000_000);
  setRuntimeErrorHandler(null);
});

describe("large but finite cascades are not cycles", () => {
  it("fully propagates a 60-link cascade without reporting a cycle", () => {
    const errors: string[] = [];
    setRuntimeErrorHandler((error) => errors.push((error as Error).message));

    const N = 60;
    const sigs = Array.from({ length: N }, () => signal(0));
    const disposers: Array<() => void> = [];

    for (let i = 0; i < N - 1; i++) {
      disposers.push(
        effect(() => {
          sigs[i + 1][1](sigs[i][0]());
        }),
      );
    }

    // Fan-in sink: legitimately re-runs once per link as the cascade advances.
    let sinkRuns = 0;
    disposers.push(
      effect(() => {
        for (let i = 0; i < N; i++) sigs[i][0]();
        sinkRuns++;
      }),
    );

    const baseline = sinkRuns;
    sigs[0][1](1);

    expect(sigs[N - 1][0]()).toBe(1); // the cascade reached the end
    expect(errors).toEqual([]); // and was never called a cycle
    expect(sinkRuns).toBeGreaterThan(baseline);

    for (const d of disposers) d();
  });

  it("propagates a cascade longer than the old 50-run ceiling", () => {
    const errors: string[] = [];
    setRuntimeErrorHandler((error) => errors.push((error as Error).message));

    const N = 200;
    const sigs = Array.from({ length: N }, () => signal(0));
    const disposers: Array<() => void> = [];
    for (let i = 0; i < N - 1; i++) {
      disposers.push(
        effect(() => {
          sigs[i + 1][1](sigs[i][0]());
        }),
      );
    }

    sigs[0][1](7);
    expect(sigs[N - 1][0]()).toBe(7);
    expect(errors).toEqual([]);
    for (const d of disposers) d();
  });
});

describe("cycle termination", () => {
  it("terminates a self-writing effect safely", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const [n, setN] = signal(0);

    // Writes its own dependency unconditionally — never stabilizes.
    const dispose = effect(() => {
      setN(n() + 1);
    });

    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("re-requested itself");
    errSpy.mockRestore();
    dispose();
  });

  it("terminates a mutual A<->B cycle safely", () => {
    setMaxSubscriberRepeats(20);
    const errors: string[] = [];
    setRuntimeErrorHandler((error) => errors.push((error as Error).message));

    const [a, setA] = signal(0);
    const [b, setB] = signal(0);

    const dA = effect(() => {
      setB(a() + 1);
    });
    const dB = effect(() => {
      setA(b() + 1);
    });

    expect(() => setA(1)).not.toThrow();
    expect(errors.join("\n")).toContain("fired more than");

    dA();
    dB();
  });
});

describe("offender isolation", () => {
  it("keeps unrelated queued work running when a cycle trips the ceiling", () => {
    setMaxSubscriberRepeats(10);
    const errors: string[] = [];
    setRuntimeErrorHandler((error) => errors.push((error as Error).message));

    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    const [c, setC] = signal(0);

    const dA = effect(() => {
      setB(a() + 1);
    });
    const dB = effect(() => {
      setA(b() + 1);
    });

    let cRuns = 0;
    let cSeen = 0;
    const dC = effect(() => {
      cSeen = c();
      cRuns++;
    });

    const baseline = cRuns;

    batch(() => {
      setA(1); // kicks the cycle
      setC(42); // unrelated, valid work
    });

    // The offender is quarantined, not the queue: C still ran and observed the
    // value it was queued for.
    expect(cRuns).toBe(baseline + 1);
    expect(cSeen).toBe(42);
    expect(errors.join("\n")).toContain("fired more than");

    dA();
    dB();
    dC();
  });

  it("quarantine lasts one drain only — the subscriber works again afterwards", () => {
    setMaxSubscriberRepeats(10);
    setRuntimeErrorHandler(() => {});

    const [a, setA] = signal(0);
    const [b, setB] = signal(0);

    let aRuns = 0;
    const dA = effect(() => {
      aRuns++;
      const v = a();
      if (v < 1000) setB(v + 1);
    });
    const dB = effect(() => {
      const v = b();
      if (v < 1000) setA(v + 1);
    });

    setA(1);
    const afterCycle = aRuns;
    expect(afterCycle).toBeGreaterThan(0);

    // A later, unrelated transaction must not find the subscriber permanently
    // disabled by an earlier drain's quarantine.
    dB(); // remove the cycle partner
    setA(5000); // above the guard, so no new cycle
    expect(aRuns).toBeGreaterThan(afterCycle);

    dA();
  });
});

describe("absolute drain ceiling", () => {
  it("still aborts the whole transaction as a last resort", () => {
    setMaxDrainIterations(5);
    setMaxSubscriberRepeats(1_000_000);
    const errors: string[] = [];
    setRuntimeErrorHandler((error) => errors.push((error as Error).message));

    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    const dA = effect(() => {
      const v = a();
      if (v < 100) setB(v + 1);
    });
    const dB = effect(() => {
      const v = b();
      if (v < 100) setA(v + 1);
    });

    expect(() => setA(1)).not.toThrow();
    expect(errors.join("\n")).toContain("absolute safety net");

    dA();
    dB();
  });
});

describe("configuration surface", () => {
  it("setMaxSubscriberRepeats returns the previous value and rejects bad input", () => {
    const prev = setMaxSubscriberRepeats(10);
    expect(typeof prev).toBe("number");
    expect(setMaxSubscriberRepeats(-5)).toBe(10);
    expect(setMaxSubscriberRepeats(Number.NaN)).toBe(10);
  });

  it("setMaxDrainIterations returns the previous value and rejects bad input", () => {
    const prev = setMaxDrainIterations(500);
    expect(typeof prev).toBe("number");
    expect(setMaxDrainIterations(0)).toBe(500);
  });
});
