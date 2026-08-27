/**
 * "auto" mode has to own ENTRY IDENTITY, not just react to popstate.
 *
 * The popstate handler restores whatever the destination entry's key names —
 * but nothing ever put a key on the entry the page STARTED on, and nothing puts
 * one on entries the application creates. So the very first Back, the one a
 * user is most likely to press, had no destination identity to look up and
 * restored nothing. Auto mode reacted automatically; it did not own the data it
 * needed to react with.
 *
 * Two things close that, and both are asserted here:
 *   - the initial entry is tagged at construction, and
 *   - `onNavigation(key)` is the deliberate integration point for entries the
 *     app creates, since no library can observe a third party calling
 *     `history.pushState` without monkey-patching it.
 *
 * Native restoration is also taken over while auto mode is active, so the
 * browser and SibuJS cannot both move the viewport.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollRestoration } from "../src/platform/scrollRestoration";

const STATE_KEY = "__sibuScrollKey";

let scrollCalls: Array<{ x: number; y: number }> = [];

function setScroll(x: number, y: number) {
  Object.defineProperty(window, "scrollX", { value: x, configurable: true });
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
}

function popTo(key: string | null) {
  const state = key === null ? null : { [STATE_KEY]: key };
  history.replaceState(state, "", "");
  window.dispatchEvent(new PopStateEvent("popstate", { state }));
}

function currentTag(): unknown {
  return (history.state as Record<string, unknown> | null)?.[STATE_KEY];
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

describe("auto mode owns entry identity", () => {
  it("tags the initial history entry at construction", () => {
    expect(currentTag()).toBeUndefined();

    const sr = scrollRestoration({ mode: "auto", getKey: () => "A" });

    expect(currentTag(), "the entry the page started on was never tagged").toBe("A");
    sr.dispose();
  });

  it("restores the first Back without any manual save()", () => {
    const sr = scrollRestoration({ mode: "auto", getKey: () => "A" });

    // The user scrolls page A, then the app navigates to B.
    setScroll(0, 640);
    sr.onNavigation("B");

    // …and scrolls B.
    setScroll(0, 120);

    // Back to A. No save("A") was ever called by hand.
    popTo("A");

    expect(scrollCalls, "A's position was not restored on the first Back").toContainEqual({ x: 0, y: 640 });
    sr.dispose();
  });

  it("restores Forward to B after going Back", () => {
    const sr = scrollRestoration({ mode: "auto", getKey: () => "A" });

    setScroll(0, 640);
    sr.onNavigation("B");
    setScroll(0, 120);

    popTo("A");
    scrollCalls = [];

    popTo("B");
    expect(scrollCalls).toContainEqual({ x: 0, y: 120 });
    sr.dispose();
  });

  it("tags the entry created by onNavigation", () => {
    const sr = scrollRestoration({ mode: "auto", getKey: () => "A" });
    sr.onNavigation("B");
    expect(currentTag()).toBe("B");
    sr.dispose();
  });

  it("preserves other history state when tagging", () => {
    history.replaceState({ routerData: 7 }, "", "/");
    const sr = scrollRestoration({ mode: "auto", getKey: () => "A" });

    expect((history.state as Record<string, unknown>).routerData).toBe(7);
    expect(currentTag()).toBe("A");
    sr.dispose();
  });

  it("records the outgoing position when onNavigation fires", () => {
    const sr = scrollRestoration({ mode: "auto", getKey: () => "A" });
    setScroll(0, 400);
    sr.onNavigation("B");

    expect(sr.getPosition("A")).toEqual({ x: 0, y: 400 });
    sr.dispose();
  });
});

describe("auto mode owns native scroll restoration", () => {
  it("switches the browser to manual while active and restores on dispose", () => {
    history.scrollRestoration = "auto";

    const sr = scrollRestoration({ mode: "auto", getKey: () => "A" });
    expect(history.scrollRestoration, "the browser was left restoring alongside SibuJS").toBe("manual");

    sr.dispose();
    expect(history.scrollRestoration).toBe("auto");
  });

  it("uses owner-stack semantics across overlapping controllers", () => {
    history.scrollRestoration = "auto";

    const a = scrollRestoration({ mode: "auto", getKey: () => "A" });
    const b = scrollRestoration({ mode: "auto", getKey: () => "B" });
    expect(history.scrollRestoration).toBe("manual");

    // Disposing one controller must not hand native restoration back while
    // another is still driving the viewport.
    a.dispose();
    expect(history.scrollRestoration).toBe("manual");

    b.dispose();
    expect(history.scrollRestoration).toBe("auto");
  });
});

describe("manual mode is unchanged", () => {
  it("does not tag the initial entry", () => {
    const sr = scrollRestoration({ mode: "manual" });
    expect(currentTag()).toBeUndefined();
    sr.dispose();
  });

  it("does not take over native scroll restoration", () => {
    history.scrollRestoration = "auto";
    const sr = scrollRestoration({ mode: "manual" });
    expect(history.scrollRestoration).toBe("auto");
    sr.dispose();
  });

  it("does not attach a popstate listener", () => {
    const sr = scrollRestoration({ mode: "manual" });
    setScroll(0, 300);
    sr.save("a");
    setScroll(0, 0);
    scrollCalls = [];
    popTo("a");
    expect(scrollCalls).toEqual([]);
    sr.dispose();
  });

  it("keeps save()/restore() working", () => {
    const sr = scrollRestoration({ mode: "manual" });
    setScroll(0, 250);
    sr.save("a");
    setScroll(0, 0);
    sr.restore("a");
    expect(scrollCalls).toContainEqual({ x: 0, y: 250 });
    expect(sr.getPosition("a")).toEqual({ x: 0, y: 250 });
    sr.dispose();
  });
});
