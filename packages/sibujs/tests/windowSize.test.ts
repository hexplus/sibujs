import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowSize } from "../src/browser/windowSize";

describe("windowSize", () => {
  let handlers: Record<string, EventListener[]>;
  let innerWidth = 1024;
  let innerHeight = 768;

  beforeEach(() => {
    handlers = {};
    innerWidth = 1024;
    innerHeight = 768;
    vi.stubGlobal("window", {
      get innerWidth() {
        return innerWidth;
      },
      get innerHeight() {
        return innerHeight;
      },
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

  it("returns initial window size", () => {
    const w = windowSize();
    expect(w.width()).toBe(1024);
    expect(w.height()).toBe(768);
  });

  it("updates on resize event", () => {
    const w = windowSize();
    innerWidth = 600;
    innerHeight = 400;
    for (const h of handlers["resize"] || []) h({} as Event);
    expect(w.width()).toBe(600);
    expect(w.height()).toBe(400);
  });

  it("dispose removes resize listener", () => {
    const w = windowSize();
    w.dispose();
    expect(handlers["resize"]?.length ?? 0).toBe(0);
  });
});
