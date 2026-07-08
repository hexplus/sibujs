import { afterEach, describe, expect, it, vi } from "vitest";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { transition } from "../src/reactivity/concurrent";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("track unlinkSub head-dependency pruning", () => {
  it("prunes a dependency that was the HEAD of the subscriber's dep list", () => {
    const [a, setA] = signal(0);
    const [tick, setTick] = signal(0);
    let readA = true;
    let runs = 0;
    // Run 1 records `a` as the FIRST (head) dependency, then `tick`. Run 2 no
    // longer reads `a`, so retrack prunes it via unlinkSub with prev === null
    // (the head branch). This must not corrupt the remaining `tick` edge.
    effect(() => {
      if (readA) a();
      tick();
      runs++;
    });
    expect(runs).toBe(1);
    readA = false;
    setTick(1); // re-run: drops head dep `a`
    expect(runs).toBe(2);
    // `a` is now untracked → changing it does not re-run the effect.
    setA(5);
    expect(runs).toBe(2);
    // `tick` is still tracked and intact.
    setTick(2);
    expect(runs).toBe(3);
  });
});

describe("transition() scheduling fallback", () => {
  it("falls back to setTimeout when requestIdleCallback and rAF are unavailable", async () => {
    // Only fake setTimeout — faking rAF too would re-install a fake
    // requestAnimationFrame and the scheduler would take the rAF path instead
    // of the setTimeout fallback we want to exercise.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("requestAnimationFrame", undefined);
    const t = transition();
    let ran = false;
    t.start(() => {
      ran = true;
    });
    expect(t.pending()).toBe(true);
    await vi.advanceTimersByTimeAsync(20); // setTimeout(fn, IDLE_FALLBACK_MS)
    expect(ran).toBe(true);
    expect(t.pending()).toBe(false);
  });
});
