import { afterEach, describe, expect, it, vi } from "vitest";
import { announce, aria, FocusTrap, focus, hotkey } from "../src/ui/a11y";

describe("aria", () => {
  it("should set ARIA attributes on element", () => {
    const el = document.createElement("div");
    aria(el, {
      label: "Test label",
      hidden: false,
      "aria-live": "polite",
    });

    expect(el.getAttribute("aria-label")).toBe("Test label");
    expect(el.getAttribute("aria-hidden")).toBe("false");
    expect(el.getAttribute("aria-live")).toBe("polite");
  });
});

describe("focus", () => {
  it("should track focus state", () => {
    const { isFocused, bind } = focus();
    const el = document.createElement("input");
    document.body.appendChild(el);
    bind(el);

    expect(isFocused()).toBe(false);

    el.dispatchEvent(new Event("focus"));
    expect(isFocused()).toBe(true);

    el.dispatchEvent(new Event("blur"));
    expect(isFocused()).toBe(false);

    document.body.removeChild(el);
  });
});

describe("hotkey", () => {
  it("should register and fire keyboard shortcut", () => {
    const handler = vi.fn();
    const cleanup = hotkey("a", handler);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(handler).toHaveBeenCalledOnce();

    cleanup();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(handler).toHaveBeenCalledOnce(); // Not called again
  });

  it("should support modifier keys", () => {
    const handler = vi.fn();
    const cleanup = hotkey("s", handler, { ctrl: true });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: false }));
    expect(handler).not.toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }));
    expect(handler).toHaveBeenCalledOnce();

    cleanup();
  });
});

describe("announce", () => {
  afterEach(() => {
    const el = document.getElementById("sibu-announce-polite");
    if (el) el.remove();
  });

  it("should create an announcement region", () => {
    announce("Hello screen reader");
    const region = document.getElementById("sibu-announce-polite");
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-live")).toBe("polite");
  });
});

describe("FocusTrap", () => {
  it("should wrap nodes in a container", () => {
    const inner = document.createElement("div");
    inner.innerHTML = "<button>A</button><button>B</button>";

    const trapped = FocusTrap(inner, { autoFocus: false });
    expect(trapped.getAttribute("data-sibu-focus-trap")).toBe("true");
    expect(trapped.contains(inner)).toBe(true);
  });
});
