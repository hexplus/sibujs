import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spring, transition } from "../src/motion/transition";

describe("transition enter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("adds enter/active classes and resolves after the duration", async () => {
    const el = document.createElement("div");
    const onEnterDone = vi.fn();
    const { enter } = transition(el, {
      duration: 200,
      delay: 0,
      enterClass: "fade-in",
      activeClass: "active",
      leaveClass: "fade-out",
      onEnterDone,
    });
    el.classList.add("fade-out");

    const p = enter();
    expect(el.style.transition).toContain("200ms");
    expect(el.classList.contains("fade-in")).toBe(true);
    expect(el.classList.contains("fade-out")).toBe(false);
    expect(el.classList.contains("active")).toBe(true);

    vi.advanceTimersByTime(200);
    await p;
    expect(el.classList.contains("fade-in")).toBe(false);
    expect(onEnterDone).toHaveBeenCalledOnce();
  });

  it("resolves synchronously when duration is 0", async () => {
    const el = document.createElement("div");
    const onEnterDone = vi.fn();
    const { enter } = transition(el, { duration: 0, enterClass: "in", onEnterDone });
    await enter();
    expect(onEnterDone).toHaveBeenCalledOnce();
    expect(el.classList.contains("in")).toBe(false);
  });
});

describe("transition leave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("adds leave class, removes active/enter, and resolves after duration", async () => {
    const el = document.createElement("div");
    const onLeaveDone = vi.fn();
    const { leave } = transition(el, {
      duration: 150,
      enterClass: "fade-in",
      leaveClass: "fade-out",
      activeClass: "active",
      onLeaveDone,
    });
    el.classList.add("active", "fade-in");

    const p = leave();
    expect(el.classList.contains("fade-out")).toBe(true);
    expect(el.classList.contains("active")).toBe(false);
    expect(el.classList.contains("fade-in")).toBe(false);

    vi.advanceTimersByTime(150);
    await p;
    expect(el.classList.contains("fade-out")).toBe(false);
    expect(onLeaveDone).toHaveBeenCalledOnce();
  });

  it("resolves synchronously when duration is 0", async () => {
    const el = document.createElement("div");
    const onLeaveDone = vi.fn();
    const { leave } = transition(el, { duration: 0, leaveClass: "out", onLeaveDone });
    await leave();
    expect(onLeaveDone).toHaveBeenCalledOnce();
  });

  it("cancels a pending enter timer when leave is called", async () => {
    const el = document.createElement("div");
    const onEnterDone = vi.fn();
    const onLeaveDone = vi.fn();
    const { enter, leave } = transition(el, { duration: 100, onEnterDone, onLeaveDone });
    enter();
    const lp = leave();
    vi.advanceTimersByTime(100);
    await lp;
    expect(onLeaveDone).toHaveBeenCalledOnce();
    // The enter timer was cancelled, so its done callback never fired.
    expect(onEnterDone).not.toHaveBeenCalled();
  });
});

describe("spring (Web Animations API)", () => {
  it("resolves when the animation finishes", async () => {
    const el = document.createElement("div");
    let finishHandler: (() => void) | null = null;
    const fakeAnimation = {
      set onfinish(fn: () => void) {
        finishHandler = fn;
      },
      set oncancel(_fn: () => void) {},
    };
    el.animate = vi.fn(() => fakeAnimation as unknown as Animation);

    const p = spring(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 100 });
    expect(el.animate).toHaveBeenCalled();
    finishHandler?.();
    await expect(p).resolves.toBeUndefined();
  });

  it("resolves when the animation is cancelled", async () => {
    const el = document.createElement("div");
    let cancelHandler: (() => void) | null = null;
    const fakeAnimation = {
      set onfinish(_fn: () => void) {},
      set oncancel(fn: () => void) {
        cancelHandler = fn;
      },
    };
    el.animate = vi.fn(() => fakeAnimation as unknown as Animation);

    const p = spring(el, [{ transform: "scale(1)" }]);
    cancelHandler?.();
    await expect(p).resolves.toBeUndefined();
  });

  it("merges default options with provided overrides", () => {
    const el = document.createElement("div");
    const animateSpy = vi.fn(
      () => ({ set onfinish(_f: () => void) {}, set oncancel(_f: () => void) {} }) as unknown as Animation,
    );
    el.animate = animateSpy;
    spring(el, [{ opacity: 1 }], { duration: 500 });
    const passedOptions = animateSpy.mock.calls[0][1] as KeyframeAnimationOptions;
    expect(passedOptions.duration).toBe(500);
    expect(passedOptions.fill).toBe("forwards");
    expect(passedOptions.easing).toContain("cubic-bezier");
  });
});
