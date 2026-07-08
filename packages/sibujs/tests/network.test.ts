import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { network } from "../src/browser/network";

describe("network", () => {
  let changeHandlers: (() => void)[];
  let connection: {
    effectiveType: string;
    downlink: number;
    rtt: number;
    saveData: boolean;
    addEventListener: (e: string, h: () => void) => void;
    removeEventListener: (e: string, h: () => void) => void;
  };

  beforeEach(() => {
    changeHandlers = [];
    connection = {
      effectiveType: "4g",
      downlink: 10,
      rtt: 50,
      saveData: false,
      addEventListener: vi.fn((_e: string, h: () => void) => {
        changeHandlers.push(h);
      }),
      removeEventListener: vi.fn((_e: string, h: () => void) => {
        changeHandlers = changeHandlers.filter((x) => x !== h);
      }),
    };
    vi.stubGlobal("navigator", { connection });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns initial values from navigator.connection", () => {
    const n = network();
    expect(n.effectiveType()).toBe("4g");
    expect(n.downlink()).toBe(10);
    expect(n.rtt()).toBe(50);
    expect(n.saveData()).toBe(false);
  });

  it("updates when the connection changes", () => {
    const n = network();
    connection.effectiveType = "2g";
    connection.downlink = 0.25;
    connection.saveData = true;
    for (const h of changeHandlers) h();
    expect(n.effectiveType()).toBe("2g");
    expect(n.downlink()).toBe(0.25);
    expect(n.saveData()).toBe(true);
  });

  it("falls back to unknown/0/false when Network Information API is unavailable", () => {
    vi.stubGlobal("navigator", {});
    const n = network();
    expect(n.effectiveType()).toBe("unknown");
    expect(n.downlink()).toBe(0);
    expect(n.rtt()).toBe(0);
    expect(n.saveData()).toBe(false);
    n.dispose(); // Should not throw
  });
});
