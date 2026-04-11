import { afterEach, describe, expect, it, vi } from "vitest";
import { vibrate } from "../src/browser/vibrate";

describe("vibrate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when navigator.vibrate is absent", () => {
    vi.stubGlobal("navigator", {});
    expect(vibrate(100)).toBe(false);
  });

  it("forwards to navigator.vibrate when available", () => {
    const spy = vi.fn(() => true);
    vi.stubGlobal("navigator", { vibrate: spy });
    expect(vibrate(50)).toBe(true);
    expect(spy).toHaveBeenCalledWith(50);
  });

  it("accepts a pattern array", () => {
    const spy = vi.fn(() => true);
    vi.stubGlobal("navigator", { vibrate: spy });
    vibrate([100, 30, 100]);
    expect(spy).toHaveBeenCalledWith([100, 30, 100]);
  });
});
