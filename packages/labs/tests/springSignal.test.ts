import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { springSignal } from "../src/motion/springSignal";

// ---------------------------------------------------------------------------
// rAF harness — capture scheduled callbacks so the test drives frame timing
// deterministically. springSignal tunes its physics to a 60 Hz reference
// timestep (REF_DT_MS = 1000/60), so we advance by ~16.67 ms per frame.
// ---------------------------------------------------------------------------

const FRAME_MS = 1000 / 60;

let rafQueue: Array<(now: number) => void>;
let now: number;

function flushFrames(count: number): void {
  for (let i = 0; i < count; i++) {
    const cbs = rafQueue;
    rafQueue = [];
    now += FRAME_MS;
    for (const cb of cbs) cb(now);
  }
}

function settle(maxFrames = 2000): number {
  let frames = 0;
  while (rafQueue.length > 0 && frames < maxFrames) {
    flushFrames(1);
    frames++;
  }
  return frames;
}

describe("springSignal", () => {
  beforeEach(() => {
    rafQueue = [];
    now = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: (now: number) => void): number => {
      rafQueue.push(cb);
      return rafQueue.length; // non-zero handle
    });
    vi.stubGlobal("cancelAnimationFrame", (_id: number): void => {
      // Test never relies on selective cancellation; dispose just stops the
      // loop because we control whether further frames are flushed.
      rafQueue = [];
    });
    // Ensure reduced-motion is OFF for the animated-path tests.
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: false })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a [get, set, dispose] tuple", () => {
    const spring = springSignal(0);
    expect(Array.isArray(spring)).toBe(true);
    expect(spring).toHaveLength(3);
    const [get, set, dispose] = spring;
    expect(typeof get).toBe("function");
    expect(typeof set).toBe("function");
    expect(typeof dispose).toBe("function");
  });

  it("getter starts at the initial value", () => {
    const [x] = springSignal(50);
    expect(x()).toBe(50);
  });

  it("does not schedule any frame before set() is called", () => {
    springSignal(0);
    expect(rafQueue.length).toBe(0);
  });

  it("schedules an animation frame when a target is set", () => {
    const [, setX] = springSignal(0);
    setX(100);
    expect(rafQueue.length).toBe(1);
  });

  it("moves the value toward the target over frames without overshooting initial gap", () => {
    const [x, setX] = springSignal(0);
    setX(100);

    flushFrames(1);
    const afterOne = x();
    expect(afterOne).toBeGreaterThan(0);

    flushFrames(1);
    const afterTwo = x();
    // Still progressing toward 100.
    expect(afterTwo).toBeGreaterThan(afterOne);
    expect(afterTwo).toBeLessThanOrEqual(100.0001);
  });

  it("value increases monotonically early in a well-damped spring", () => {
    const [x, setX] = springSignal(0, { stiffness: 0.15, damping: 0.9 });
    setX(100);

    let prev = x();
    for (let i = 0; i < 10; i++) {
      flushFrames(1);
      const cur = x();
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = cur;
    }
  });

  it("eventually settles exactly on the target and stops scheduling frames", () => {
    const [x, setX] = springSignal(0, { stiffness: 0.2, damping: 0.9, precision: 0.01 });
    setX(100);

    const frames = settle();
    expect(frames).toBeLessThan(2000);
    expect(x()).toBe(100);
    // No further frames pending once settled.
    expect(rafQueue.length).toBe(0);
  });

  it("settles toward a negative target", () => {
    const [x, setX] = springSignal(0, { stiffness: 0.2, damping: 0.9 });
    setX(-25);

    settle();
    expect(x()).toBe(-25);
  });

  it("retargets mid-flight and reaches the new target", () => {
    const [x, setX] = springSignal(0, { stiffness: 0.2, damping: 0.9 });
    setX(100);
    flushFrames(3);
    expect(x()).toBeGreaterThan(0);
    expect(x()).toBeLessThan(100);

    // Change target while in motion.
    setX(10);
    settle();
    expect(x()).toBe(10);
  });

  it("does not start a second loop when set() is called while already animating", () => {
    const [, setX] = springSignal(0, { stiffness: 0.2, damping: 0.9 });
    setX(100);
    expect(rafQueue.length).toBe(1);

    // Setting a new target while a frame is already pending must not stack
    // an extra concurrent rAF callback.
    setX(200);
    expect(rafQueue.length).toBe(1);
  });

  it("dispose() cancels the loop and freezes the value", () => {
    const [x, setX, dispose] = springSignal(0, { stiffness: 0.2, damping: 0.9 });
    setX(100);
    flushFrames(2);
    const frozen = x();
    expect(frozen).toBeGreaterThan(0);
    expect(frozen).toBeLessThan(100);

    dispose();
    expect(rafQueue.length).toBe(0);

    // No more frames possible; value stays put.
    flushFrames(5);
    expect(x()).toBe(frozen);
  });

  it("snaps instantly to target when prefers-reduced-motion is enabled", () => {
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: true })),
    });
    const [x, setX] = springSignal(0);
    setX(100);

    // Snaps synchronously, no animation frame scheduled.
    expect(x()).toBe(100);
    expect(rafQueue.length).toBe(0);
  });

  it("falls back to a reference timestep when rAF supplies a non-progressing clock", () => {
    const [x, setX] = springSignal(0, { stiffness: 0.2, damping: 0.9 });
    setX(100);

    // Drive frames with a frozen / broken clock: callbacks fire but `now`
    // never advances. The dt guard should substitute the reference timestep
    // so the spring still progresses instead of stalling.
    for (let i = 0; i < 5; i++) {
      const cbs = rafQueue;
      rafQueue = [];
      for (const cb of cbs) cb(now); // now stays 0
    }
    expect(x()).toBeGreaterThan(0);
  });
});
