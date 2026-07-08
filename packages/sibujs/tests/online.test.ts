import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { online } from "../src/browser/online";

describe("online", () => {
  let eventHandlers: Record<string, (() => void)[]>;

  beforeEach(() => {
    eventHandlers = {};

    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", {
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (!eventHandlers[event]) eventHandlers[event] = [];
        eventHandlers[event].push(handler);
      }),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when navigator is online", () => {
    const { online: isOnline } = online();
    expect(isOnline()).toBe(true);
  });

  it("returns false when navigator is offline", () => {
    (navigator as unknown as { onLine: boolean }).onLine = false;
    const { online: isOnline } = online();
    expect(isOnline()).toBe(false);
  });

  it("updates to false when offline event fires", () => {
    const { online: isOnline } = online();
    expect(isOnline()).toBe(true);

    // Trigger offline event
    for (const handler of eventHandlers["offline"] || []) handler();
    expect(isOnline()).toBe(false);
  });

  it("updates to true when online event fires after going offline", () => {
    (navigator as unknown as { onLine: boolean }).onLine = false;
    const { online: isOnline } = online();
    expect(isOnline()).toBe(false);

    // Trigger online event
    for (const handler of eventHandlers["online"] || []) handler();
    expect(isOnline()).toBe(true);
  });
});
