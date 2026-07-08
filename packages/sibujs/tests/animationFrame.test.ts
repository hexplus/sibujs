import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { animationFrame } from "../src/browser/animationFrame";

describe("animationFrame", () => {
  let callbacks: ((ts: number) => void)[];
  let nextId: number;

  beforeEach(() => {
    callbacks = [];
    nextId = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: (ts: number) => void) => {
        callbacks.push(cb);
        return ++nextId;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((_id: number) => {
        // Just clear — tests pump manually
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pump(ts: number) {
    const pending = callbacks;
    callbacks = [];
    for (const cb of pending) cb(ts);
  }

  it("starts running by default and reports running=true", () => {
    const f = animationFrame();
    expect(f.running()).toBe(true);
    f.dispose();
  });

  it("updates elapsed and delta on each frame", () => {
    const f = animationFrame();
    pump(1000); // first tick establishes the start
    expect(f.elapsed()).toBe(0);
    pump(1016); // ~16ms later
    expect(f.delta()).toBe(16);
    expect(f.elapsed()).toBe(16);
    f.dispose();
  });

  it("pause stops the loop and resume restarts it", () => {
    const f = animationFrame();
    f.pause();
    expect(f.running()).toBe(false);
    f.resume();
    expect(f.running()).toBe(true);
    f.dispose();
  });

  it("fpsLimit drops frames that arrive too fast", () => {
    const f = animationFrame({ fpsLimit: 30 }); // ~33ms minimum
    pump(0);
    pump(10); // too fast, should be ignored
    expect(f.elapsed()).toBe(0);
    pump(40); // after limit — accepted
    expect(f.elapsed()).toBe(40);
    f.dispose();
  });

  it("immediate:false does not start until resume", () => {
    const f = animationFrame({ immediate: false });
    expect(f.running()).toBe(false);
    f.resume();
    expect(f.running()).toBe(true);
    f.dispose();
  });
});
