import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollRestoration } from "../src/platform/scrollRestoration";

describe("scrollRestoration", () => {
  beforeEach(() => {
    // Mock window.scrollX, scrollY, scrollTo, addEventListener, removeEventListener
    vi.stubGlobal("scrollX", 0);
    vi.stubGlobal("scrollY", 0);
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal("addEventListener", vi.fn());
    vi.stubGlobal("removeEventListener", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves and restores scroll positions", () => {
    const sr = scrollRestoration({ mode: "manual" });

    // Simulate scroll position
    vi.stubGlobal("scrollX", 100);
    vi.stubGlobal("scrollY", 250);

    sr.save("/page1");

    expect(sr.getPosition("/page1")).toEqual({ x: 100, y: 250 });

    sr.restore("/page1");
    expect(window.scrollTo).toHaveBeenCalledWith(100, 250);

    sr.dispose();
  });

  it("returns undefined for unknown keys", () => {
    const sr = scrollRestoration({ mode: "manual" });

    expect(sr.getPosition("/unknown")).toBe(undefined);

    sr.dispose();
  });

  it("saves multiple positions for different keys", () => {
    const sr = scrollRestoration({ mode: "manual" });

    vi.stubGlobal("scrollX", 0);
    vi.stubGlobal("scrollY", 100);
    sr.save("/page1");

    vi.stubGlobal("scrollX", 50);
    vi.stubGlobal("scrollY", 200);
    sr.save("/page2");

    expect(sr.getPosition("/page1")).toEqual({ x: 0, y: 100 });
    expect(sr.getPosition("/page2")).toEqual({ x: 50, y: 200 });

    sr.dispose();
  });

  it("registers popstate listener in auto mode", () => {
    const sr = scrollRestoration({ mode: "auto" });

    expect(window.addEventListener).toHaveBeenCalledWith("popstate", expect.any(Function));

    sr.dispose();
    expect(window.removeEventListener).toHaveBeenCalledWith("popstate", expect.any(Function));
  });

  it("does not register popstate listener in manual mode", () => {
    const sr = scrollRestoration({ mode: "manual" });

    expect(window.addEventListener).not.toHaveBeenCalled();

    sr.dispose();
  });

  it("dispose clears all stored positions", () => {
    const sr = scrollRestoration({ mode: "manual" });

    vi.stubGlobal("scrollX", 10);
    vi.stubGlobal("scrollY", 20);
    sr.save("/page1");

    expect(sr.getPosition("/page1")).toBeDefined();

    sr.dispose();

    expect(sr.getPosition("/page1")).toBe(undefined);
  });
});
