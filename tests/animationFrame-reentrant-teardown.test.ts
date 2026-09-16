import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { animationFrame } from "../src/browser/animationFrame";
import { effect } from "../src/core/signals/effect";

// ---------------------------------------------------------------------------
// animationFrame() stopped from inside a frame.
//
// THE DEFECT: `step()` published `delta` and `elapsed`, whose subscribers run
// synchronously, and then unconditionally requested the next frame. A
// subscriber calling `pause()` or `dispose()` flipped `running()` to false, but
// the loop kept scheduling frames and publishing values indefinitely — a
// full-speed browser loop that `dispose()` promised to end permanently.
// ---------------------------------------------------------------------------

// A rAF stub with real cancellation, so "queued" means genuinely pending.
let queue: Map<number, (ts: number) => void>;
let nextId: number;

beforeEach(() => {
  queue = new Map();
  nextId = 0;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((cb: (ts: number) => void) => {
      const id = ++nextId;
      queue.set(id, cb);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      queue.delete(id);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function pump(ts: number): void {
  const pending = Array.from(queue.entries());
  queue.clear();
  for (const [, cb] of pending) cb(ts);
}

type Signal = "delta" | "elapsed";
type Stop = "pause" | "dispose";

for (const observed of ["delta", "elapsed"] as Signal[]) {
  for (const stop of ["pause", "dispose"] as Stop[]) {
    it(`an effect on ${observed}() calling ${stop}() mid-frame leaves no frame queued`, () => {
      const f = animationFrame();
      pump(1000);

      const stopEffect = effect(() => {
        if (f[observed]() > 0) f[stop]();
      });

      pump(1016);

      expect(f.running()).toBe(false);
      expect(queue.size).toBe(0);

      // Nothing keeps publishing afterwards.
      const deltaBefore = f.delta();
      const elapsedBefore = f.elapsed();
      pump(1032);
      pump(1048);
      expect(queue.size).toBe(0);
      expect(f.delta()).toBe(deltaBefore);
      expect(f.elapsed()).toBe(elapsedBefore);
      stopEffect();
    });
  }
}

describe("animationFrame reentrant control", () => {
  it("dispose() from inside a frame is permanent: resume() cannot restart it", () => {
    const f = animationFrame();
    pump(0);
    const stopEffect = effect(() => {
      if (f.delta() > 0) f.dispose();
    });
    pump(16);

    f.resume();

    expect(f.running()).toBe(false);
    expect(queue.size).toBe(0);
    stopEffect();
  });

  it("pause() then resume() inside a frame keeps exactly one frame queued", () => {
    const f = animationFrame();
    pump(0);
    let restarted = false;
    const stopEffect = effect(() => {
      if (f.delta() > 0 && !restarted) {
        restarted = true;
        f.pause();
        f.resume();
      }
    });

    pump(16);

    expect(f.running()).toBe(true);
    expect(queue.size).toBe(1);

    // The restarted loop begins a fresh timeline.
    pump(100);
    expect(f.delta()).toBe(0);
    expect(f.elapsed()).toBe(0);
    pump(116);
    expect(f.delta()).toBe(16);
    expect(f.elapsed()).toBe(16);
    expect(queue.size).toBe(1);
    stopEffect();
    f.dispose();
  });

  it("an effect on running() calling pause() when it starts leaves no frame queued", () => {
    const f = animationFrame({ immediate: false });
    const stopEffect = effect(() => {
      if (f.running()) f.pause();
    });

    f.resume();

    expect(f.running()).toBe(false);
    expect(queue.size).toBe(0);
    stopEffect();
  });

  it("keeps exactly one frame queued during normal running", () => {
    const f = animationFrame();
    for (let t = 0; t < 100; t += 16) {
      pump(t);
      expect(queue.size).toBe(1);
    }
    f.dispose();
    expect(queue.size).toBe(0);
  });
});
