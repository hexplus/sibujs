import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibility } from "../src/browser/visibility";

describe("visibility", () => {
  let eventHandlers: Record<string, (() => void)[]>;
  let hidden = false;

  beforeEach(() => {
    eventHandlers = {};
    hidden = false;

    vi.stubGlobal("document", {
      get hidden() {
        return hidden;
      },
      addEventListener: vi.fn((event: string, handler: () => void) => {
        (eventHandlers[event] ||= []).push(handler);
      }),
      removeEventListener: vi.fn((event: string, handler: () => void) => {
        eventHandlers[event] = (eventHandlers[event] || []).filter((h) => h !== handler);
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns visible=true when document is visible initially", () => {
    const { visible } = visibility();
    expect(visible()).toBe(true);
  });

  it("returns visible=false when document starts hidden", () => {
    hidden = true;
    const { visible } = visibility();
    expect(visible()).toBe(false);
  });

  it("updates when visibilitychange fires", () => {
    const { visible } = visibility();
    expect(visible()).toBe(true);
    hidden = true;
    for (const h of eventHandlers["visibilitychange"] || []) h();
    expect(visible()).toBe(false);
    hidden = false;
    for (const h of eventHandlers["visibilitychange"] || []) h();
    expect(visible()).toBe(true);
  });

  it("dispose removes listener", () => {
    const { dispose } = visibility();
    dispose();
    expect(eventHandlers["visibilitychange"]?.length ?? 0).toBe(0);
  });
});
