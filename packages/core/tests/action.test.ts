import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { action, autoResize, clickOutside, copyOnClick, longPress, trapFocus } from "../src/core/rendering/action";

describe("action", () => {
  it("should call actionFn with element and param", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    action(el, fn, "hello");
    expect(fn).toHaveBeenCalledWith(el, "hello");
  });

  it("should call actionFn without param for void actions", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    action(el, fn);
    expect(fn).toHaveBeenCalledWith(el, undefined);
  });
});

describe("clickOutside", () => {
  it("should fire callback when clicking outside element", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const callback = vi.fn();

    const cleanup = clickOutside(el, callback);

    // Click outside
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(callback).toHaveBeenCalledTimes(1);

    // Cleanup
    cleanup?.();
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(callback).toHaveBeenCalledTimes(1); // not called again

    document.body.removeChild(el);
  });
});

describe("longPress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("should fire callback after duration", () => {
    const el = document.createElement("div");
    const callback = vi.fn();

    const cleanup = longPress(el, { duration: 500, callback });

    el.dispatchEvent(new Event("pointerdown"));
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledTimes(1);

    cleanup?.();
  });

  it("should cancel on pointerup", () => {
    const el = document.createElement("div");
    const callback = vi.fn();

    const cleanup = longPress(el, { duration: 500, callback });

    el.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(200);
    el.dispatchEvent(new Event("pointerup"));
    vi.advanceTimersByTime(500);

    expect(callback).not.toHaveBeenCalled();
    cleanup?.();
  });

  it("should cancel on pointerleave", () => {
    const el = document.createElement("div");
    const callback = vi.fn();

    const cleanup = longPress(el, { duration: 500, callback });

    el.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(200);
    el.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(500);

    expect(callback).not.toHaveBeenCalled();
    cleanup?.();
  });

  it("should default duration to 500ms", () => {
    const el = document.createElement("div");
    const callback = vi.fn();

    const cleanup = longPress(el, { callback });

    el.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(499);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);

    cleanup?.();
  });
});

describe("copyOnClick", () => {
  it("should copy element textContent on click", () => {
    const el = document.createElement("div");
    el.textContent = "copy me";

    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    const cleanup = copyOnClick(el, undefined as unknown as undefined);

    el.dispatchEvent(new Event("click"));
    expect(writeTextMock).toHaveBeenCalledWith("copy me");

    cleanup?.();
  });

  it("should copy custom getter text on click", () => {
    const el = document.createElement("div");
    el.textContent = "visible text";

    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    const cleanup = copyOnClick(el, () => "secret value");

    el.dispatchEvent(new Event("click"));
    expect(writeTextMock).toHaveBeenCalledWith("secret value");

    cleanup?.();
  });

  it("should clean up click listener", () => {
    const el = document.createElement("div");
    el.textContent = "text";

    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    const cleanup = copyOnClick(el, undefined as unknown as undefined);
    cleanup?.();

    el.dispatchEvent(new Event("click"));
    expect(writeTextMock).not.toHaveBeenCalled();
  });
});

describe("autoResize", () => {
  it("should set initial height based on scrollHeight", () => {
    const el = document.createElement("textarea");
    Object.defineProperty(el, "scrollHeight", { value: 100, configurable: true });

    const cleanup = autoResize(el);

    expect(el.style.overflow).toBe("hidden");
    expect(el.style.height).toBe("100px");

    cleanup?.();
  });

  it("should resize on input event", () => {
    const el = document.createElement("textarea");
    let scrollH = 50;
    Object.defineProperty(el, "scrollHeight", {
      get: () => scrollH,
      configurable: true,
    });

    const cleanup = autoResize(el);
    expect(el.style.height).toBe("50px");

    scrollH = 120;
    el.dispatchEvent(new Event("input"));
    expect(el.style.height).toBe("120px");

    cleanup?.();
  });

  it("should clean up input listener", () => {
    const el = document.createElement("textarea");
    Object.defineProperty(el, "scrollHeight", { value: 50, configurable: true });

    const cleanup = autoResize(el);
    cleanup?.();

    // After cleanup, height shouldn't change on input
    el.style.height = "999px";
    el.dispatchEvent(new Event("input"));
    expect(el.style.height).toBe("999px");
  });
});

describe("trapFocus", () => {
  it("should wrap focus from last to first on Tab", () => {
    const container = document.createElement("div");
    const btn1 = document.createElement("button");
    const btn2 = document.createElement("button");
    container.appendChild(btn1);
    container.appendChild(btn2);
    document.body.appendChild(container);

    const cleanup = trapFocus(container);

    // Simulate focus on last button
    btn2.focus();
    Object.defineProperty(document, "activeElement", {
      value: btn2,
      configurable: true,
    });

    const tabEvent = new KeyboardEvent("keydown", { key: "Tab" });
    const preventDefaultSpy = vi.spyOn(tabEvent, "preventDefault");
    container.dispatchEvent(tabEvent);

    expect(preventDefaultSpy).toHaveBeenCalled();

    cleanup?.();
    document.body.removeChild(container);
  });
});
