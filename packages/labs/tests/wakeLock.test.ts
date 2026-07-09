import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wakeLock } from "../src/browser/wakeLock";

describe("wakeLock", () => {
  let handlers: Record<string, EventListener[]>;
  let hidden = false;

  beforeEach(() => {
    handlers = {};
    hidden = false;

    const sentinelListeners: Record<string, EventListener[]> = {};
    const sentinel = {
      released: false,
      type: "screen" as const,
      release: vi.fn(async function (this: { released: boolean }) {
        this.released = true;
        for (const fn of sentinelListeners["release"] || []) fn({} as Event);
      }),
      addEventListener: vi.fn((event: string, handler: EventListener) => {
        (sentinelListeners[event] ||= []).push(handler);
      }),
      removeEventListener: vi.fn(),
    };

    vi.stubGlobal("navigator", {
      wakeLock: {
        request: vi.fn(async () => sentinel),
      },
    });
    vi.stubGlobal("document", {
      get hidden() {
        return hidden;
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

  it("starts inactive", () => {
    const w = wakeLock();
    expect(w.active()).toBe(false);
  });

  it("request sets active=true", async () => {
    const w = wakeLock();
    await w.request();
    expect(w.active()).toBe(true);
  });

  it("release sets active=false", async () => {
    const w = wakeLock();
    await w.request();
    await w.release();
    expect(w.active()).toBe(false);
  });

  it("a second request() while active does not acquire another sentinel", async () => {
    const w = wakeLock();
    const api = (navigator as unknown as { wakeLock: { request: ReturnType<typeof vi.fn> } }).wakeLock;

    await w.request();
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(w.active()).toBe(true);

    // A concurrent request must be a no-op while a live sentinel is held —
    // otherwise the previous sentinel is orphaned (only the latest is releasable).
    await w.request();
    expect(api.request).toHaveBeenCalledTimes(1);
    expect(w.active()).toBe(true);
  });

  it("gracefully handles missing wakeLock API", async () => {
    vi.stubGlobal("navigator", {});
    const w = wakeLock();
    await w.request();
    expect(w.active()).toBe(false);
    await w.release();
  });
});
