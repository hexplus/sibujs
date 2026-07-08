import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { battery } from "../src/browser/battery";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("battery", () => {
  let batteryListeners: Record<string, (() => void)[]>;
  let mockBattery: Record<string, unknown>;

  beforeEach(() => {
    batteryListeners = {};

    mockBattery = {
      level: 0.75,
      charging: true,
      chargingTime: 1800,
      dischargingTime: Infinity,
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (!batteryListeners[event]) batteryListeners[event] = [];
        batteryListeners[event].push(handler);
      }),
      removeEventListener: vi.fn(),
    };

    vi.stubGlobal("navigator", {
      getBattery: vi.fn(() => Promise.resolve(mockBattery)),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports supported as true when Battery API is available", () => {
    const { supported } = battery();
    expect(supported()).toBe(true);
  });

  it("returns null values before battery promise resolves", () => {
    const { level, charging } = battery();
    expect(level()).toBeNull();
    expect(charging()).toBeNull();
  });

  it("populates battery values after promise resolves", async () => {
    const { level, charging, chargingTime, dischargingTime } = battery();
    await tick();

    expect(level()).toBe(0.75);
    expect(charging()).toBe(true);
    expect(chargingTime()).toBe(1800);
    expect(dischargingTime()).toBe(Infinity);
  });

  it("updates reactively when battery events fire", async () => {
    const { level, charging } = battery();
    await tick();

    mockBattery.level = 0.5;
    for (const handler of batteryListeners["levelchange"] || []) handler();
    expect(level()).toBe(0.5);

    mockBattery.charging = false;
    for (const handler of batteryListeners["chargingchange"] || []) handler();
    expect(charging()).toBe(false);
  });

  it("removes event listeners on dispose", async () => {
    const { dispose } = battery();
    await tick();

    dispose();
    expect(mockBattery.removeEventListener).toHaveBeenCalledWith("levelchange", expect.any(Function));
    expect(mockBattery.removeEventListener).toHaveBeenCalledWith("chargingchange", expect.any(Function));
    expect(mockBattery.removeEventListener).toHaveBeenCalledWith("chargingtimechange", expect.any(Function));
    expect(mockBattery.removeEventListener).toHaveBeenCalledWith("dischargingtimechange", expect.any(Function));
  });
});
