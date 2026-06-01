import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fullscreen } from "../src/browser/fullscreen";

describe("fullscreen (coverage2)", () => {
  let fsElement: Element | null;

  beforeEach(() => {
    fsElement = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fsElement,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (document as unknown as { fullscreenElement?: unknown }).fullscreenElement;
    delete (document as unknown as { exitFullscreen?: unknown }).exitFullscreen;
  });

  it("degrades when document is undefined", () => {
    vi.stubGlobal("document", undefined);
    const fs = fullscreen();
    expect(fs.isFullscreen()).toBe(false);
    expect(fs.element()).toBe(null);
    expect(() => {
      fs.enter({} as Element);
      fs.exit();
      fs.toggle({} as Element);
      fs.dispose();
    }).not.toThrow();
    vi.unstubAllGlobals();
  });

  it("syncs state from the fullscreenchange event", () => {
    const fs = fullscreen();
    expect(fs.isFullscreen()).toBe(false);
    const el = document.createElement("div");
    fsElement = el;
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(fs.isFullscreen()).toBe(true);
    expect(fs.element()).toBe(el);
  });

  it("enter calls requestFullscreen when not already fullscreen", async () => {
    const fs = fullscreen();
    const el = document.createElement("div");
    const req = vi.fn(async () => {});
    (el as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = req;
    await fs.enter(el);
    expect(req).toHaveBeenCalled();
  });

  it("enter is a no-op when already fullscreen", async () => {
    fsElement = document.createElement("div");
    const fs = fullscreen();
    const el = document.createElement("div");
    const req = vi.fn(async () => {});
    (el as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = req;
    await fs.enter(el);
    expect(req).not.toHaveBeenCalled();
  });

  it("exit calls exitFullscreen when in fullscreen", async () => {
    fsElement = document.createElement("div");
    const exitFn = vi.fn(async () => {});
    (document as unknown as { exitFullscreen: () => Promise<void> }).exitFullscreen = exitFn;
    const fs = fullscreen();
    await fs.exit();
    expect(exitFn).toHaveBeenCalled();
  });

  it("exit is a no-op when not in fullscreen", async () => {
    const exitFn = vi.fn(async () => {});
    (document as unknown as { exitFullscreen: () => Promise<void> }).exitFullscreen = exitFn;
    const fs = fullscreen();
    await fs.exit();
    expect(exitFn).not.toHaveBeenCalled();
  });

  it("toggle enters when not fullscreen", async () => {
    const fs = fullscreen();
    const el = document.createElement("div");
    const req = vi.fn(async () => {});
    (el as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = req;
    await fs.toggle(el);
    expect(req).toHaveBeenCalled();
  });

  it("toggle exits when already fullscreen", async () => {
    fsElement = document.createElement("div");
    const exitFn = vi.fn(async () => {});
    (document as unknown as { exitFullscreen: () => Promise<void> }).exitFullscreen = exitFn;
    const fs = fullscreen();
    await fs.toggle(document.createElement("div"));
    expect(exitFn).toHaveBeenCalled();
  });

  it("dispose removes the fullscreenchange listener", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const fs = fullscreen();
    fs.dispose();
    expect(removeSpy).toHaveBeenCalledWith("fullscreenchange", expect.any(Function));
  });
});
