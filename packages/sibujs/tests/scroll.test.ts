import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scroll } from "../src/browser/scroll";

describe("scroll", () => {
  let scrollHandler: ((event?: Event) => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    scrollHandler = null;

    vi.stubGlobal("window", {
      scrollX: 0,
      scrollY: 0,
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === "scroll") scrollHandler = handler;
      }),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns initial scroll position of 0,0", () => {
    const { x, y } = scroll();
    expect(x()).toBe(0);
    expect(y()).toBe(0);
  });

  it("updates scroll position on scroll event", () => {
    const { x, y } = scroll();

    (window as unknown as Record<string, unknown>).scrollX = 100;
    (window as unknown as Record<string, unknown>).scrollY = 250;
    scrollHandler?.();

    expect(x()).toBe(100);
    expect(y()).toBe(250);
  });

  it("sets isScrolling true during scroll and false after 150ms", () => {
    const { isScrolling } = scroll();

    expect(isScrolling()).toBe(false);

    scrollHandler?.();
    expect(isScrolling()).toBe(true);

    vi.advanceTimersByTime(100);
    expect(isScrolling()).toBe(true);

    vi.advanceTimersByTime(50);
    expect(isScrolling()).toBe(false);
  });

  it("resets isScrolling timer on successive scrolls", () => {
    const { isScrolling } = scroll();

    scrollHandler?.();
    expect(isScrolling()).toBe(true);

    vi.advanceTimersByTime(100);
    scrollHandler?.(); // another scroll before 150ms
    vi.advanceTimersByTime(100);
    expect(isScrolling()).toBe(true); // still scrolling

    vi.advanceTimersByTime(50);
    expect(isScrolling()).toBe(false); // 150ms since last scroll
  });

  it("cleans up on dispose", () => {
    const { dispose } = scroll();
    dispose();
    expect(window.removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));
  });
});
