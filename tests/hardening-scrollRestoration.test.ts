/**
 * scrollRestoration "auto" mode contract.
 *
 * The public API documents auto mode as save/restore on popstate. Saving alone
 * is not restoration: the whole point of the feature is that going BACK returns
 * the viewport where the user left it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollRestoration } from "../src/platform/scrollRestoration";

let scrollCalls: Array<{ x: number; y: number }> = [];

function setScroll(x: number, y: number) {
  Object.defineProperty(window, "scrollX", { value: x, configurable: true });
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
}

function popTo(key: string | null) {
  const state = key === null ? null : { __sibuScrollKey: key };
  window.dispatchEvent(new PopStateEvent("popstate", { state }));
}

beforeEach(() => {
  scrollCalls = [];
  setScroll(0, 0);
  vi.spyOn(window, "scrollTo").mockImplementation(((x: number, y: number) => {
    scrollCalls.push({ x, y });
    setScroll(x, y);
  }) as typeof window.scrollTo);
  history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scrollRestoration — manual mode (unchanged contract)", () => {
  it("saves and restores explicitly", () => {
    const sr = scrollRestoration({ mode: "manual" });
    setScroll(0, 250);
    sr.save("a");
    setScroll(0, 0);
    sr.restore("a");

    expect(scrollCalls).toContainEqual({ x: 0, y: 250 });
    sr.dispose();
  });

  it("returns a saved position", () => {
    const sr = scrollRestoration({ mode: "manual" });
    setScroll(10, 20);
    sr.save("a");
    expect(sr.getPosition("a")).toEqual({ x: 10, y: 20 });
    sr.dispose();
  });

  it("no-ops on an unknown key", () => {
    const sr = scrollRestoration({ mode: "manual" });
    sr.restore("never-saved");
    expect(scrollCalls).toEqual([]);
    sr.dispose();
  });

  it("does not attach a popstate listener in manual mode", () => {
    const sr = scrollRestoration({ mode: "manual" });
    setScroll(0, 100);
    sr.save("a");
    setScroll(0, 0);
    popTo("a");
    expect(scrollCalls).toEqual([]);
    sr.dispose();
  });
});

describe("scrollRestoration — auto mode actually restores", () => {
  it("restores the destination entry's position on popstate", () => {
    const sr = scrollRestoration({ mode: "auto", getKey: () => "a" });

    // On page A, scrolled down.
    setScroll(0, 400);
    sr.save("a");

    // Navigate to B, scrolled elsewhere.
    setScroll(0, 50);
    sr.save("b");

    // Go back to A.
    setScroll(0, 0);
    popTo("a");

    expect(scrollCalls).toContainEqual({ x: 0, y: 400 });
    sr.dispose();
  });

  it("saves the outgoing entry before restoring the destination", () => {
    const sr = scrollRestoration({ mode: "auto", getKey: () => "a" });

    setScroll(0, 400);
    sr.save("a");
    setScroll(0, 120);
    sr.save("b");

    // Currently on B at y=333 when the user hits Back.
    setScroll(0, 333);
    popTo("a");

    // Going forward again must return to where B actually was.
    setScroll(0, 0);
    popTo("b");

    expect(scrollCalls).toContainEqual({ x: 0, y: 333 });
    sr.dispose();
  });

  it("keeps positions for A and B separate", () => {
    const sr = scrollRestoration({ mode: "auto", getKey: () => "a" });

    setScroll(0, 400);
    sr.save("a");
    setScroll(0, 120);
    sr.save("b");

    expect(sr.getPosition("a")).toEqual({ x: 0, y: 400 });
    expect(sr.getPosition("b")).toEqual({ x: 0, y: 120 });
    sr.dispose();
  });

  it("safely no-ops for an unknown destination key", () => {
    const sr = scrollRestoration({ mode: "auto", getKey: () => "a" });
    setScroll(0, 90);
    sr.save("a");

    scrollCalls = [];
    popTo("unknown-key");
    expect(scrollCalls).toEqual([]);
    sr.dispose();
  });

  it("safely no-ops when the popstate entry carries no key", () => {
    const sr = scrollRestoration({ mode: "auto", getKey: () => "a" });
    setScroll(0, 90);
    sr.save("a");

    scrollCalls = [];
    popTo(null);
    expect(scrollCalls).toEqual([]);
    sr.dispose();
  });

  it("uses a caller-provided getKey for the outgoing entry", () => {
    let current = "route-1";
    const sr = scrollRestoration({ mode: "auto", getKey: () => current });

    setScroll(0, 210);
    // No explicit save() — auto mode owns the outgoing save via getKey.
    current = "route-2";
    popTo("route-2");

    expect(sr.getPosition("route-1")).toEqual({ x: 0, y: 210 });
    sr.dispose();
  });

  it("removes its popstate listener on dispose", () => {
    const sr = scrollRestoration({ mode: "auto", getKey: () => "a" });
    setScroll(0, 400);
    sr.save("a");
    sr.dispose();

    scrollCalls = [];
    popTo("a");
    expect(scrollCalls).toEqual([]);
  });

  it("two controllers do not fight over the same destination", () => {
    const a = scrollRestoration({ mode: "auto", getKey: () => "k" });
    const b = scrollRestoration({ mode: "auto", getKey: () => "k" });

    setScroll(0, 500);
    a.save("k");
    b.save("k");

    setScroll(0, 0);
    popTo("k");

    // Both agree on the target, so every restore lands on the same position.
    for (const call of scrollCalls) expect(call).toEqual({ x: 0, y: 500 });
    a.dispose();
    b.dispose();
  });
});
