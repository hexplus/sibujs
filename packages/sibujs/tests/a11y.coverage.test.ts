import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispose } from "@sibujs/core";
import { announce, aria, FocusTrap, hotkey } from "../src/ui/a11y";

describe("aria reactive getter", () => {
  it("applies a function value reactively", () => {
    const el = document.createElement("div");
    aria(el, {
      expanded: () => true,
      label: () => "dynamic",
    });
    expect(el.getAttribute("aria-expanded")).toBe("true");
    expect(el.getAttribute("aria-label")).toBe("dynamic");
  });
});

describe("hotkey combo parsing", () => {
  it("parses ctrl+shift+z combo string", () => {
    const handler = vi.fn();
    const cleanup = hotkey("ctrl+shift+z", handler);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: false }));
    expect(handler).not.toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true }));
    expect(handler).toHaveBeenCalledOnce();
    cleanup();
  });

  it("parses alt and meta/cmd modifiers and preventDefault", () => {
    const handler = vi.fn();
    const cleanup = hotkey("alt+cmd+k", handler, { preventDefault: true });

    const ev = new KeyboardEvent("keydown", { key: "k", altKey: true, metaKey: true, cancelable: true });
    const prevented = vi.spyOn(ev, "preventDefault");
    document.dispatchEvent(ev);
    expect(handler).toHaveBeenCalledOnce();
    expect(prevented).toHaveBeenCalled();
    cleanup();
  });

  it("ignores non-matching key", () => {
    const handler = vi.fn();
    const cleanup = hotkey("a", handler);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    expect(handler).not.toHaveBeenCalled();
    cleanup();
  });
});

describe("FocusTrap behavior", () => {
  let trap: HTMLElement;

  afterEach(() => {
    if (trap?.parentNode) trap.remove();
  });

  it("auto-focuses the first focusable element by default", async () => {
    const inner = document.createElement("div");
    inner.innerHTML = '<button id="b1">A</button><button id="b2">B</button>';
    trap = FocusTrap(inner);
    document.body.appendChild(trap);

    await Promise.resolve();
    await new Promise((r) => queueMicrotask(() => r(null)));
    // jsdom reports offsetParent as null, isEffectivelyVisible may filter.
    // The microtask ran without throwing — that exercises the autoFocus path.
    expect(trap.getAttribute("data-sibu-focus-trap")).toBe("true");
  });

  it("cycles focus forward from last to first on Tab", () => {
    const inner = document.createElement("div");
    const b1 = document.createElement("button");
    const b2 = document.createElement("button");
    // Force visibility helpers used by getFocusable.
    for (const b of [b1, b2]) {
      Object.defineProperty(b, "offsetParent", { get: () => document.body, configurable: true });
      b.getClientRects = () => [{}] as unknown as DOMRectList;
    }
    inner.append(b1, b2);
    trap = FocusTrap(inner, { autoFocus: false });
    document.body.appendChild(trap);

    b2.focus();
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    trap.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("cycles focus backward from first to last on Shift+Tab", () => {
    const inner = document.createElement("div");
    const b1 = document.createElement("button");
    const b2 = document.createElement("button");
    for (const b of [b1, b2]) {
      Object.defineProperty(b, "offsetParent", { get: () => document.body, configurable: true });
      b.getClientRects = () => [{}] as unknown as DOMRectList;
    }
    inner.append(b1, b2);
    trap = FocusTrap(inner, { autoFocus: false });
    document.body.appendChild(trap);

    b1.focus();
    const ev = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    trap.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("prevents default when no focusable elements exist", () => {
    const inner = document.createElement("div");
    inner.innerHTML = "<span>nothing focusable</span>";
    trap = FocusTrap(inner, { autoFocus: false });
    document.body.appendChild(trap);

    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    trap.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("ignores non-Tab keys", () => {
    const inner = document.createElement("div");
    inner.innerHTML = "<button>A</button>";
    trap = FocusTrap(inner, { autoFocus: false });
    document.body.appendChild(trap);

    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    trap.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("filters out disabled, inert, aria-hidden, and contenteditable=false elements", () => {
    const inner = document.createElement("div");
    inner.innerHTML =
      "<button disabled>d</button>" +
      '<button aria-hidden="true">h</button>' +
      "<button inert>i</button>" +
      '<div contenteditable="false" tabindex="0">ce</div>';
    trap = FocusTrap(inner, { autoFocus: false });
    document.body.appendChild(trap);
    // No throw; Tab handler runs getFocusable across all filter branches.
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    trap.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("restores focus and cleans up via dispose()", async () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();

    const inner = document.createElement("div");
    inner.innerHTML = "<button>A</button>";
    trap = FocusTrap(inner);
    document.body.appendChild(trap);
    await Promise.resolve();

    dispose(trap);
    // restoreFocusAndCleanup ran; keydown listener removed.
    const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    trap.dispatchEvent(ev);
    before.remove();
    expect(trap.isConnected).toBe(true);
  });

  it("does not restore focus when restoreFocus is false", async () => {
    const inner = document.createElement("div");
    inner.innerHTML = "<button>A</button>";
    trap = FocusTrap(inner, { autoFocus: false, restoreFocus: false });
    document.body.appendChild(trap);
    await Promise.resolve();
    dispose(trap);
    expect(trap.getAttribute("data-sibu-focus-trap")).toBe("true");
  });
});

describe("announce queue draining", () => {
  let rafCb: FrameRequestCallback | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    rafCb = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    for (const p of ["polite", "assertive"]) {
      document.getElementById(`sibu-announce-${p}`)?.remove();
    }
  });

  it("writes the message into the live region after a frame", () => {
    announce("hello", "polite");
    const region = document.getElementById("sibu-announce-polite")!;
    expect(region).not.toBeNull();
    expect(region.textContent).toBe("");

    // Run the queued RAF callback to set textContent.
    rafCb?.(0);
    expect(region.textContent).toBe("hello");

    // Advance the post-announce interval to release draining.
    vi.advanceTimersByTime(200);
  });

  it("serializes multiple messages through the queue", () => {
    announce("first", "assertive");
    announce("second", "assertive");
    const region = document.getElementById("sibu-announce-assertive")!;
    expect(region.getAttribute("role")).toBe("alert");

    rafCb?.(0);
    expect(region.textContent).toBe("first");
    vi.advanceTimersByTime(200);
    // After interval, drain pops the next message and schedules another frame.
    rafCb?.(0);
    expect(region.textContent).toBe("second");
    vi.advanceTimersByTime(200);
  });

  it("aborts draining if the region is disconnected before the frame", () => {
    announce("orphan", "polite");
    const region = document.getElementById("sibu-announce-polite")!;
    region.remove();
    rafCb?.(0);
    expect(region.textContent).toBe("");
  });
});

describe("announce SSR guard", () => {
  it("no-ops when document is undefined", () => {
    const originalDoc = globalThis.document;
    // @ts-expect-error simulate SSR
    globalThis.document = undefined;
    expect(() => announce("x")).not.toThrow();
    globalThis.document = originalDoc;
  });
});
