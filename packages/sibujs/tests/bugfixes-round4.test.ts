// Regression tests for the round-4 bug review fixes.
import { describe, expect, it, vi } from "vitest";
import { deepSignal } from "@sibujs/core";
import { effect } from "@sibujs/core";
import { signal } from "@sibujs/core";
import { batch } from "@sibujs/core";
import { transition } from "../src/ui/transition";

describe("effect: disposed-while-enqueued must not run its body", () => {
  it("does not run an effect disposed while it sits in the pending queue", () => {
    const [count, setCount] = signal(0);
    const runs: number[] = [];

    const disposeEffect = effect(() => {
      runs.push(count());
    });
    expect(runs).toEqual([0]);

    // Inside a batch, the write enqueues the effect but the drain is deferred
    // to batch-exit. Disposing it before the drain must prevent its body from
    // running — "dispose" means "stop".
    batch(() => {
      setCount(1); // enqueues the effect
      disposeEffect(); // dispose while still enqueued
    });

    expect(runs).toEqual([0]); // body did NOT run after disposal

    setCount(2);
    expect(runs).toEqual([0]); // stays disposed
  });
});

describe("deepSignal/deepEqual fixes", () => {
  it("treats objects with different key sets as not equal (no missed update)", () => {
    const [state, setState] = deepSignal<Record<string, unknown>>({ a: undefined, b: 2 });
    let runs = 0;
    effect(() => {
      state();
      runs++;
    });
    expect(runs).toBe(1);

    // Different key set (x instead of a), same length, both "a"/"x" undefined.
    setState({ x: undefined, b: 2 });
    expect(runs).toBe(2); // must be detected as a change
  });

  it("distinguishes DataViews with different contents", () => {
    const a = new DataView(new ArrayBuffer(2));
    a.setUint8(0, 1);
    const b = new DataView(new ArrayBuffer(2));
    b.setUint8(0, 2);

    const [view, setView] = deepSignal<DataView>(a);
    let runs = 0;
    effect(() => {
      view();
      runs++;
    });
    expect(runs).toBe(1);
    setView(b);
    expect(runs).toBe(2); // different bytes -> change detected
  });

  it("still treats genuinely-equal objects as equal (no spurious update)", () => {
    const [state, setState] = deepSignal({ a: 1, b: { c: 2 } });
    let runs = 0;
    effect(() => {
      state();
      runs++;
    });
    expect(runs).toBe(1);
    setState({ a: 1, b: { c: 2 } }); // deep-equal -> no notification
    expect(runs).toBe(1);
  });
});

describe("transition: interrupted promise still settles", () => {
  it("resolves enter() when leave() interrupts it (no hang)", async () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    const t = transition(el, { duration: 100 });

    let enterDone = false;
    const enterPromise = t.enter().then(() => {
      enterDone = true;
    });

    // Interrupt before the 100ms enter completes.
    const leavePromise = t.leave();

    await vi.advanceTimersByTimeAsync(0);
    await enterPromise; // must not hang
    expect(enterDone).toBe(true);

    await vi.advanceTimersByTimeAsync(150);
    await leavePromise;

    vi.useRealTimers();
  });
});
