import { afterEach, describe, expect, it, vi } from "vitest";
import { dialog } from "../src/ui/dialog";

describe("dialog", () => {
  let keydownHandlers: ((e: KeyboardEvent) => void)[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    keydownHandlers = [];
  });

  function setupWindow(): void {
    vi.stubGlobal("window", {
      addEventListener: vi.fn((_event: string, handler: (e: KeyboardEvent) => void) => {
        keydownHandlers.push(handler);
      }),
      removeEventListener: vi.fn((_event: string, handler: (e: KeyboardEvent) => void) => {
        keydownHandlers = keydownHandlers.filter((h) => h !== handler);
      }),
    });
  }

  it("starts closed", () => {
    setupWindow();
    const d = dialog();
    expect(d.isOpen()).toBe(false);
  });

  it("opens and closes", () => {
    setupWindow();
    const d = dialog();

    d.open();
    expect(d.isOpen()).toBe(true);

    d.close();
    expect(d.isOpen()).toBe(false);
  });

  it("toggles state", () => {
    setupWindow();
    const d = dialog();

    d.toggle();
    expect(d.isOpen()).toBe(true);

    d.toggle();
    expect(d.isOpen()).toBe(false);
  });

  it("closes on Escape key", () => {
    setupWindow();
    const d = dialog();

    d.open();
    expect(d.isOpen()).toBe(true);

    // Simulate Escape keypress
    for (const handler of keydownHandlers) {
      handler({ key: "Escape" } as KeyboardEvent);
    }
    expect(d.isOpen()).toBe(false);
  });

  it("removes keydown listener on close", () => {
    setupWindow();
    const d = dialog();

    d.open();
    expect(keydownHandlers.length).toBe(1);

    d.close();
    expect(keydownHandlers.length).toBe(0);
  });

  it("does not respond to non-Escape keys", () => {
    setupWindow();
    const d = dialog();

    d.open();
    for (const handler of keydownHandlers) {
      handler({ key: "Enter" } as KeyboardEvent);
    }
    expect(d.isOpen()).toBe(true);
  });
});
