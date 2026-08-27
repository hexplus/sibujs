/**
 * `onNavigation()` is an AUTO-MODE hook and must be inert in manual mode.
 *
 * Manual mode's whole contract is that nothing happens unless the caller asks
 * for it: no listener, no native-restoration claim, no tagging — you call
 * `save()` and `restore()` yourself. But `onNavigation()` was returned in both
 * modes and did its full auto-mode work either way, so a manual controller
 * could rewrite `history.state`, move its internal current key, and record a
 * position the caller never asked it to record.
 *
 * It stays on the returned object in both modes (removing it would be a
 * needless API asymmetry); it simply does nothing outside auto mode.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollRestoration } from "../src/platform/scrollRestoration";

const STATE_KEY = "__sibuScrollKey";

let scrollCalls: Array<{ x: number; y: number }> = [];

function setScroll(x: number, y: number) {
  Object.defineProperty(window, "scrollX", { value: x, configurable: true });
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
}

beforeEach(() => {
  scrollCalls = [];
  setScroll(0, 0);
  history.replaceState(null, "", "/");
  vi.spyOn(window, "scrollTo").mockImplementation(((x: number, y: number) => {
    scrollCalls.push({ x, y });
    setScroll(x, y);
  }) as typeof window.scrollTo);
});

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("manual mode — onNavigation() is inert", () => {
  it("does not touch history.state", () => {
    history.replaceState({ routerData: 42 }, "", "/");
    const before = JSON.stringify(history.state);

    const sr = scrollRestoration({ mode: "manual" });
    sr.onNavigation("B");

    expect(JSON.stringify(history.state), "manual mode rewrote history.state").toBe(before);
    expect((history.state as Record<string, unknown>)[STATE_KEY]).toBeUndefined();
    sr.dispose();
  });

  it("does not implicitly record a position", () => {
    const sr = scrollRestoration({ mode: "manual", getKey: () => "A" });

    setScroll(0, 500);
    sr.onNavigation("B");

    expect(sr.getPosition("A"), "manual mode recorded a position on its own").toBeUndefined();
    expect(sr.getPosition("B")).toBeUndefined();
    sr.dispose();
  });

  it("does not shift the key used by a later explicit save()", () => {
    const sr = scrollRestoration({ mode: "manual", getKey: () => "A" });

    setScroll(0, 500);
    sr.onNavigation("B");

    // An explicit save must still land exactly where the caller says.
    setScroll(0, 275);
    sr.save("A");

    expect(sr.getPosition("A")).toEqual({ x: 0, y: 275 });
    expect(sr.getPosition("B")).toBeUndefined();
    sr.dispose();
  });

  it("leaves explicit save()/restore() working normally", () => {
    const sr = scrollRestoration({ mode: "manual" });

    setScroll(0, 320);
    sr.save("page");
    sr.onNavigation("ignored");
    setScroll(0, 0);
    sr.restore("page");

    expect(scrollCalls).toContainEqual({ x: 0, y: 320 });
    expect(sr.getPosition("page")).toEqual({ x: 0, y: 320 });
    sr.dispose();
  });

  it("still exposes onNavigation on the returned object", () => {
    const sr = scrollRestoration({ mode: "manual" });
    expect(typeof sr.onNavigation).toBe("function");
    sr.dispose();
  });

  it("does not claim native scroll restoration", () => {
    history.scrollRestoration = "auto";
    const sr = scrollRestoration({ mode: "manual" });
    sr.onNavigation("B");
    expect(history.scrollRestoration).toBe("auto");
    sr.dispose();
  });
});

describe("auto mode — onNavigation() still does its job", () => {
  it("tags the new entry and records the outgoing position", () => {
    const sr = scrollRestoration({ mode: "auto", getKey: () => "A" });

    setScroll(0, 610);
    sr.onNavigation("B");

    expect((history.state as Record<string, unknown>)[STATE_KEY]).toBe("B");
    expect(sr.getPosition("A")).toEqual({ x: 0, y: 610 });
    sr.dispose();
  });

  it("preserves unrelated history state while tagging", () => {
    history.replaceState({ routerData: 7 }, "", "/");
    const sr = scrollRestoration({ mode: "auto", getKey: () => "A" });
    sr.onNavigation("B");

    expect((history.state as Record<string, unknown>).routerData).toBe(7);
    expect((history.state as Record<string, unknown>)[STATE_KEY]).toBe("B");
    sr.dispose();
  });
});
