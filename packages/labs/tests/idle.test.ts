import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { idle } from "../src/browser/idle";

describe("idle", () => {
  let eventHandlers: Record<string, ((event?: Event) => void)[]>;

  beforeEach(() => {
    vi.useFakeTimers();
    eventHandlers = {};

    vi.stubGlobal("document", {
      addEventListener: vi.fn((event: string, handler: (e?: Event) => void) => {
        if (!eventHandlers[event]) eventHandlers[event] = [];
        eventHandlers[event].push(handler);
      }),
      removeEventListener: vi.fn(),
    });

    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts as not idle", () => {
    const { idle: isIdle } = idle(1000);
    expect(isIdle()).toBe(false);
  });

  it("becomes idle after timeout", () => {
    const { idle: isIdle } = idle(1000);
    expect(isIdle()).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(isIdle()).toBe(true);
  });

  it("resets idle state on user activity", () => {
    const { idle: isIdle } = idle(1000);

    vi.advanceTimersByTime(800);
    expect(isIdle()).toBe(false);

    // Simulate mouse activity
    for (const handler of eventHandlers["mousemove"] || []) handler();
    vi.advanceTimersByTime(800);
    expect(isIdle()).toBe(false); // reset, only 800ms since last activity

    vi.advanceTimersByTime(200);
    expect(isIdle()).toBe(true); // 1000ms since last activity
  });

  it("uses default timeout of 60000ms", () => {
    const { idle: isIdle } = idle();

    vi.advanceTimersByTime(59999);
    expect(isIdle()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(isIdle()).toBe(true);
  });

  it("registers listeners for all activity events", () => {
    idle(1000);
    const registeredEvents = (document.addEventListener as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0],
    );

    expect(registeredEvents).toContain("mousemove");
    expect(registeredEvents).toContain("mousedown");
    expect(registeredEvents).toContain("keydown");
    expect(registeredEvents).toContain("touchstart");
    expect(registeredEvents).toContain("scroll");
  });
});
