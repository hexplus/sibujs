import { signal } from "@sibujs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { animationFrame } from "../src/browser/animationFrame";
import { bounds } from "../src/browser/bounds";
import { gamepad } from "../src/browser/gamepad";
import { pointerLock } from "../src/browser/pointerLock";
import { resize } from "../src/browser/resize";
import { scroll } from "../src/browser/scroll";
import { title } from "../src/browser/title";
import { wakeLock } from "../src/browser/wakeLock";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("scroll", () => {
  it("tracks a target element's scroll position and clears its timer on dispose", () => {
    vi.useFakeTimers();
    const el = document.createElement("div");
    document.body.appendChild(el);
    Object.defineProperty(el, "scrollLeft", { value: 40, configurable: true });
    Object.defineProperty(el, "scrollTop", { value: 80, configurable: true });
    const s = scroll(() => el);
    el.dispatchEvent(new Event("scroll"));
    expect(s.x()).toBe(40);
    expect(s.y()).toBe(80);
    expect(s.isScrolling()).toBe(true);
    s.dispose(); // clears the pending isScrolling reset timer
    document.body.removeChild(el);
  });

  it("tracks the window when no target is given", () => {
    const s = scroll();
    window.dispatchEvent(new Event("scroll"));
    expect(s.isScrolling()).toBe(true);
    s.dispose();
  });

  it("no-ops without window", () => {
    vi.stubGlobal("window", undefined);
    const s = scroll();
    expect(s.x()).toBe(0);
    expect(s.isScrolling()).toBe(false);
    s.dispose();
  });
});

describe("bounds with ResizeObserver", () => {
  it("observes size changes via ResizeObserver and disposes", () => {
    let disconnects = 0;
    class FakeRO {
      cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe() {
        this.cb();
      }
      disconnect() {
        disconnects++;
      }
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", FakeRO);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const b = bounds(el);
    expect(b.rect()).toBeTruthy();
    b.refresh();
    window.dispatchEvent(new Event("scroll")); // position listener
    b.dispose();
    expect(disconnects).toBe(1);
    document.body.removeChild(el);
  });
});

describe("resize", () => {
  it("observes an element, re-observes on target change, and disposes", () => {
    const observed: Element[] = [];
    let disconnects = 0;
    class FakeRO {
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe(el: Element) {
        observed.push(el);
        this.cb([{ contentRect: { width: 100, height: 50 } } as ResizeObserverEntry], this as never);
      }
      disconnect() {
        disconnects++;
      }
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", FakeRO);
    const [target, setTarget] = signal<HTMLElement | null>(document.createElement("div"));
    const r = resize(() => target());
    expect(r.width()).toBe(100);
    expect(r.height()).toBe(50);
    setTarget(document.createElement("section")); // effect re-runs → disconnect old, observe new
    expect(disconnects).toBeGreaterThan(0);
    setTarget(null); // re-run with no element → just disconnect
    r.dispose();
  });

  it("no-ops without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const r = resize(() => document.createElement("div"));
    expect(r.width()).toBe(0);
    r.dispose();
  });
});

describe("animationFrame loop", () => {
  it("runs the rAF step loop, emits delta/elapsed, and pauses", () => {
    let cb: ((t: number) => void) | null = null;
    let raf = 1;
    vi.stubGlobal("requestAnimationFrame", (fn: (t: number) => void) => {
      cb = fn;
      return raf++;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const f = animationFrame({ fpsLimit: 60 });
    expect(f.running()).toBe(true);
    cb?.(0); // first tick
    cb?.(100); // second tick → delta accrues
    expect(f.elapsed()).toBeGreaterThanOrEqual(0);
    f.pause();
    expect(f.running()).toBe(false);
    f.dispose();
  });

  it("does not start when immediate is false", () => {
    vi.stubGlobal("requestAnimationFrame", (_fn: (t: number) => void) => 1);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const f = animationFrame({ immediate: false });
    expect(f.running()).toBe(false);
    f.resume();
    expect(f.running()).toBe(true);
    f.dispose();
  });
});

describe("pointerLock", () => {
  it("reacts to pointerlockchange and requests/exits the lock", () => {
    const reqSpy = vi.fn();
    const exitSpy = vi.fn();
    Object.defineProperty(document, "exitPointerLock", { value: exitSpy, configurable: true });
    const pl = pointerLock();
    const el = document.createElement("div");
    (el as unknown as { requestPointerLock: () => void }).requestPointerLock = reqSpy;
    pl.request(el);
    expect(reqSpy).toHaveBeenCalled();
    document.dispatchEvent(new Event("pointerlockchange"));
    pl.exit();
    expect(exitSpy).toHaveBeenCalled();
    pl.dispose();
  });
});

describe("title reactive", () => {
  it("updates document.title reactively and restores on dispose", () => {
    const original = document.title;
    const [t, setT] = signal("first");
    const restore = title(() => t());
    expect(document.title).toBe("first");
    setT("second");
    expect(document.title).toBe("second");
    restore();
    expect(document.title).toBe(original);
  });

  it("sets a static title and restores it on dispose", () => {
    const original = document.title;
    const restore = title("static-title");
    expect(document.title).toBe("static-title");
    restore();
    expect(document.title).toBe(original);
  });
});

describe("gamepad", () => {
  function makePad(index: number) {
    return {
      index,
      id: `pad-${index}`,
      connected: true,
      buttons: [{ pressed: false, value: 0 }],
      axes: [0, 0],
    };
  }

  it("polls connected pads and stops when all disconnect", () => {
    let cb: ((t: number) => void) | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: (t: number) => void) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let pads: (ReturnType<typeof makePad> | null)[] = [makePad(0)];
    vi.stubGlobal("navigator", { getGamepads: () => pads });

    const gp = gamepad();
    // Initial connected pad → polling started; run a couple of poll frames.
    cb?.(0);
    expect(gp.pads().length).toBe(1);
    // Connect event keeps polling; disconnect with a remaining pad keeps polling.
    window.dispatchEvent(new Event("gamepadconnected"));
    window.dispatchEvent(new Event("gamepaddisconnected"));
    // Now remove all pads and disconnect → stopPolling path.
    pads = [];
    window.dispatchEvent(new Event("gamepaddisconnected"));
    gp.dispose();
  });

  it("no-ops without getGamepads", () => {
    vi.stubGlobal("navigator", {});
    const gp = gamepad();
    expect(gp.pads()).toEqual([]);
    gp.dispose();
  });
});

describe("wakeLock", () => {
  it("requests, releases, and re-acquires on visibility return", async () => {
    let releaseHandler: (() => void) | null = null;
    const sentinel = {
      released: false,
      type: "screen" as const,
      release: vi.fn(() => {
        sentinel.released = true;
        return Promise.resolve();
      }),
      addEventListener: (_e: string, h: () => void) => {
        releaseHandler = h;
      },
      removeEventListener: vi.fn(),
    };
    const request = vi.fn(() => Promise.resolve(sentinel));
    vi.stubGlobal("navigator", { wakeLock: { request } });

    const lock = wakeLock();
    await lock.request();
    expect(lock.active()).toBe(true);
    releaseHandler?.(); // sentinel released event
    expect(lock.active()).toBe(false);

    // Simulate auto-release then visibility return → re-acquire.
    sentinel.released = true;
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();

    await lock.release();
    lock.dispose();
    expect(request).toHaveBeenCalled();
  });

  it("no-ops when the API is unsupported", async () => {
    vi.stubGlobal("navigator", {});
    const lock = wakeLock();
    expect(lock.active()).toBe(false);
    await lock.request();
    await lock.release();
    lock.dispose();
  });
});
