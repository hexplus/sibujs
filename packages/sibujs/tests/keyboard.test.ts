import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyboard } from "../src/browser/keyboard";

describe("keyboard", () => {
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

  function fire(type: string, key: string) {
    for (const h of handlers[type] || []) h({ key } as unknown as Event);
  }

  it("adds keys on keydown and removes on keyup", () => {
    const kb = keyboard();
    expect(kb.pressed().size).toBe(0);
    fire("keydown", "a");
    expect(kb.isPressed("a")).toBe(true);
    fire("keydown", "Shift");
    expect(kb.pressed().size).toBe(2);
    fire("keyup", "a");
    expect(kb.isPressed("a")).toBe(false);
    expect(kb.isPressed("Shift")).toBe(true);
  });

  it("ignores keys outside the filter", () => {
    const kb = keyboard({ keys: ["Escape"] });
    fire("keydown", "a");
    expect(kb.isPressed("a")).toBe(false);
    fire("keydown", "Escape");
    expect(kb.isPressed("Escape")).toBe(true);
  });

  it("clears on window blur", () => {
    const kb = keyboard();
    fire("keydown", "a");
    fire("keydown", "b");
    expect(kb.pressed().size).toBe(2);
    for (const h of handlers["blur"] || []) h({} as Event);
    expect(kb.pressed().size).toBe(0);
  });

  it("dispose removes listeners", () => {
    const kb = keyboard();
    kb.dispose();
    expect(handlers["keydown"]?.length ?? 0).toBe(0);
    expect(handlers["keyup"]?.length ?? 0).toBe(0);
  });
});
