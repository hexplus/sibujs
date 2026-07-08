import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mouse } from "../src/browser/mouse";

describe("mouse", () => {
  let handlers: Record<string, EventListener[]>;

  beforeEach(() => {
    handlers = {};
    vi.stubGlobal("window", {
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

  it("starts at 0/0 and tracks mousemove", () => {
    const m = mouse();
    expect(m.x()).toBe(0);
    expect(m.y()).toBe(0);

    for (const h of handlers["mousemove"] || []) {
      h({ clientX: 42, clientY: 99 } as unknown as Event);
    }
    expect(m.x()).toBe(42);
    expect(m.y()).toBe(99);
  });

  it("tracks touchmove when touch is enabled", () => {
    const m = mouse({ touch: true });
    for (const h of handlers["touchmove"] || []) {
      h({ touches: [{ clientX: 12, clientY: 34 }] } as unknown as Event);
    }
    expect(m.x()).toBe(12);
    expect(m.y()).toBe(34);
  });

  it("does not attach touch listeners when touch is false", () => {
    mouse({ touch: false });
    expect(handlers["touchmove"]).toBeUndefined();
  });

  it("dispose removes listeners", () => {
    const m = mouse();
    m.dispose();
    expect(handlers["mousemove"]?.length ?? 0).toBe(0);
    expect(handlers["touchmove"]?.length ?? 0).toBe(0);
  });
});
