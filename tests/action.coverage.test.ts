import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ActionFn,
  action,
  autoResize,
  clickOutside,
  copyOnClick,
  longPress,
  trapFocus,
} from "../src/core/rendering/action";
import { dispose } from "../src/core/rendering/dispose";

describe("action()", () => {
  it("invokes the action function with the element and parameter", () => {
    const el = document.createElement("div");
    const fn = vi.fn<ActionFn<number>>(() => undefined);
    action(el, fn, 7);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(el, 7);
  });

  it("supports param-less actions", () => {
    const el = document.createElement("div");
    const fn = vi.fn<ActionFn<void>>(() => undefined);
    action(el, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toBe(el);
  });

  it("registers the returned cleanup as a disposer", () => {
    const el = document.createElement("div");
    const cleanup = vi.fn();
    action(el, () => cleanup, undefined);
    expect(cleanup).not.toHaveBeenCalled();
    dispose(el);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not register a disposer when the action returns nothing", () => {
    const el = document.createElement("div");
    action(el, () => undefined, undefined);
    // No throw and no cleanup invoked on dispose.
    expect(() => dispose(el)).not.toThrow();
  });

  it("composes multiple actions on the same element", () => {
    const el = document.createElement("div");
    const c1 = vi.fn();
    const c2 = vi.fn();
    action(el, () => c1, undefined);
    action(el, () => c2, undefined);
    dispose(el);
    expect(c1).toHaveBeenCalledTimes(1);
    expect(c2).toHaveBeenCalledTimes(1);
  });
});

describe("clickOutside", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("fires the callback when a pointerdown happens outside the element", () => {
    const el = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(el, outside);
    const cb = vi.fn();
    action(el, clickOutside, cb);

    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the pointerdown is inside the element", () => {
    const el = document.createElement("div");
    const child = document.createElement("span");
    el.appendChild(child);
    document.body.appendChild(el);
    const cb = vi.fn();
    action(el, clickOutside, cb);

    child.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(cb).not.toHaveBeenCalled();
  });

  it("removes the document listener on dispose", () => {
    const el = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(el, outside);
    const cb = vi.fn();
    action(el, clickOutside, cb);
    dispose(el);

    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("longPress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("fires the callback after the default duration", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const callback = vi.fn();
    action(el, longPress, { callback });

    el.dispatchEvent(new Event("pointerdown"));
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("respects a custom duration", () => {
    const el = document.createElement("div");
    const callback = vi.fn();
    action(el, longPress, { duration: 800, callback });

    el.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(500);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("cancels on pointerup before the duration elapses", () => {
    const el = document.createElement("div");
    const callback = vi.fn();
    action(el, longPress, { callback });

    el.dispatchEvent(new Event("pointerdown"));
    el.dispatchEvent(new Event("pointerup"));
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("cancels on pointerleave before the duration elapses", () => {
    const el = document.createElement("div");
    const callback = vi.fn();
    action(el, longPress, { callback });

    el.dispatchEvent(new Event("pointerdown"));
    el.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("removes listeners and clears a pending timer on dispose", () => {
    const el = document.createElement("div");
    const callback = vi.fn();
    action(el, longPress, { callback });

    el.dispatchEvent(new Event("pointerdown"));
    dispose(el);
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
    // Listener removed: a fresh pointerdown after dispose does nothing.
    el.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("copyOnClick", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("copies the element's textContent on click by default", () => {
    const el = document.createElement("div");
    el.textContent = "copy me";
    action(el, copyOnClick);

    el.dispatchEvent(new Event("click"));
    expect(writeText).toHaveBeenCalledWith("copy me");
  });

  it("uses a custom text getter when provided", () => {
    const el = document.createElement("div");
    el.textContent = "ignored";
    action(el, copyOnClick, () => "custom value");

    el.dispatchEvent(new Event("click"));
    expect(writeText).toHaveBeenCalledWith("custom value");
  });

  it("removes the click listener on dispose", () => {
    const el = document.createElement("div");
    el.textContent = "x";
    action(el, copyOnClick);
    dispose(el);

    el.dispatchEvent(new Event("click"));
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("autoResize", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("sets height styles based on scrollHeight on attach", () => {
    const ta = document.createElement("textarea");
    Object.defineProperty(ta, "scrollHeight", { value: 120, configurable: true });
    action(ta, autoResize);
    expect(ta.style.overflow).toBe("hidden");
    expect(ta.style.height).toBe("120px");
  });

  it("re-resizes on input", () => {
    const ta = document.createElement("textarea");
    let h = 50;
    Object.defineProperty(ta, "scrollHeight", { get: () => h, configurable: true });
    action(ta, autoResize);
    expect(ta.style.height).toBe("50px");

    h = 200;
    ta.dispatchEvent(new Event("input"));
    expect(ta.style.height).toBe("200px");
  });

  it("stops resizing on input after dispose", () => {
    const ta = document.createElement("textarea");
    let h = 50;
    Object.defineProperty(ta, "scrollHeight", { get: () => h, configurable: true });
    action(ta, autoResize);
    dispose(ta);

    h = 999;
    ta.dispatchEvent(new Event("input"));
    expect(ta.style.height).toBe("50px");
  });
});

describe("trapFocus", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function buildDialog() {
    const el = document.createElement("div");
    const first = document.createElement("button");
    first.textContent = "first";
    const middle = document.createElement("input");
    const last = document.createElement("button");
    last.textContent = "last";
    el.append(first, middle, last);
    document.body.appendChild(el);
    return { el, first, last };
  }

  it("cycles from last to first on Tab", () => {
    const { el, first, last } = buildDialog();
    action(el, trapFocus);
    last.focus();
    expect(document.activeElement).toBe(last);

    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("cycles from first to last on Shift+Tab", () => {
    const { el, first, last } = buildDialog();
    action(el, trapFocus);
    first.focus();

    const ev = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it("ignores non-Tab keys", () => {
    const { el, first } = buildDialog();
    action(el, trapFocus);
    first.focus();

    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("does nothing when there are no focusable elements", () => {
    const el = document.createElement("div");
    el.appendChild(document.createElement("span"));
    document.body.appendChild(el);
    action(el, trapFocus);

    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("removes the keydown listener on dispose", () => {
    const { el, last } = buildDialog();
    action(el, trapFocus);
    dispose(el);
    last.focus();

    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
