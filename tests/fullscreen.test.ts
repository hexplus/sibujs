import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fullscreen } from "../src/browser/fullscreen";

describe("fullscreen", () => {
  let handlers: Record<string, EventListener[]>;
  let fullscreenElement: Element | null;

  beforeEach(() => {
    handlers = {};
    fullscreenElement = null;

    vi.stubGlobal("document", {
      get fullscreenElement() {
        return fullscreenElement;
      },
      exitFullscreen: vi.fn(async () => {
        fullscreenElement = null;
      }),
      addEventListener: vi.fn((event: string, handler: EventListener) => {
        (handlers[event] ||= []).push(handler);
      }),
      removeEventListener: vi.fn((event: string, handler: EventListener) => {
        handlers[event] = (handlers[event] || []).filter((h) => h !== handler);
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("initial state is not fullscreen", () => {
    const fs = fullscreen();
    expect(fs.isFullscreen()).toBe(false);
    expect(fs.element()).toBe(null);
  });

  it("enter calls requestFullscreen on the target element", async () => {
    const el = { requestFullscreen: vi.fn(async () => {}) } as unknown as Element;
    const fs = fullscreen();
    await fs.enter(el);
    expect(el.requestFullscreen).toHaveBeenCalled();
  });

  it("updates signals on fullscreenchange event", () => {
    const fs = fullscreen();
    const fakeEl = { tagName: "DIV" } as unknown as Element;
    fullscreenElement = fakeEl;
    for (const h of handlers["fullscreenchange"] || []) h({} as Event);
    expect(fs.isFullscreen()).toBe(true);
    expect(fs.element()).toBe(fakeEl);
  });

  it("exit calls document.exitFullscreen when active", async () => {
    fullscreenElement = { tagName: "DIV" } as unknown as Element;
    const fs = fullscreen();
    await fs.exit();
    expect(document.exitFullscreen).toHaveBeenCalled();
  });

  it("dispose removes the listener", () => {
    const fs = fullscreen();
    fs.dispose();
    expect(handlers["fullscreenchange"]?.length ?? 0).toBe(0);
  });
});
