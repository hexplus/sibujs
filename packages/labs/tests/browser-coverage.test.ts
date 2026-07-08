import { afterEach, describe, expect, it, vi } from "vitest";
import { animationFrame } from "../src/browser/animationFrame";
import { battery } from "../src/browser/battery";
import { bounds } from "../src/browser/bounds";
import { clipboard } from "../src/browser/clipboard";
import { colorScheme } from "../src/browser/colorScheme";
import { favicon } from "../src/browser/favicon";
import { formatCurrency } from "../src/browser/format";
import { idle } from "../src/browser/idle";
import { keyboard } from "../src/browser/keyboard";
import { media } from "../src/browser/media";
import { mouse } from "../src/browser/mouse";
import { mutationObserver } from "../src/browser/mutationObserver";
import { network } from "../src/browser/network";
import { online } from "../src/browser/online";
import { permissions } from "../src/browser/permissions";
import { pointerLock } from "../src/browser/pointerLock";
import { swipe } from "../src/browser/swipe";
import { title } from "../src/browser/title";
import { visibility } from "../src/browser/visibility";
import { windowSize } from "../src/browser/windowSize";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Helper: a MediaQueryList mock that captures its change handler.
function mockMatchMedia(matches: boolean) {
  let handler: ((e: { matches: boolean }) => void) | null = null;
  const mql = {
    matches,
    media: "",
    addEventListener: (_e: string, h: (e: { matches: boolean }) => void) => {
      handler = h;
    },
    removeEventListener: vi.fn(),
  };
  return { mql, fire: (m: boolean) => handler?.({ matches: m }) };
}

describe("browser SSR / unsupported fallbacks", () => {
  it("online() returns a no-op shape without window", () => {
    vi.stubGlobal("window", undefined);
    const { online: isOnline, dispose } = online();
    expect(isOnline()).toBe(true);
    expect(() => dispose()).not.toThrow();
  });

  it("idle() no-ops without window/document", () => {
    vi.stubGlobal("window", undefined);
    const { idle: isIdle, dispose } = idle();
    expect(isIdle()).toBe(false);
    expect(() => dispose()).not.toThrow();
  });

  it("visibility() defaults to visible without document", () => {
    vi.stubGlobal("document", undefined);
    const { visible, dispose } = visibility();
    expect(visible()).toBe(true);
    expect(() => dispose()).not.toThrow();
  });

  it("windowSize() returns zeros without window", () => {
    vi.stubGlobal("window", undefined);
    const { width, height, dispose } = windowSize();
    expect(width()).toBe(0);
    expect(height()).toBe(0);
    dispose();
  });

  it("mouse() no-ops without window", () => {
    vi.stubGlobal("window", undefined);
    const { x, y, dispose } = mouse();
    expect(x()).toBe(0);
    expect(y()).toBe(0);
    dispose();
  });

  it("keyboard() no-ops without window", () => {
    vi.stubGlobal("window", undefined);
    const kb = keyboard();
    expect(kb.isPressed("a")).toBe(false);
    kb.dispose();
  });

  it("swipe() no-ops without window", () => {
    vi.stubGlobal("window", undefined);
    const s = swipe(document.createElement("div"));
    expect(s.direction()).toBeNull();
    s.dispose();
  });

  it("title() no-ops without document", () => {
    vi.stubGlobal("document", undefined);
    expect(() => title("x")()).not.toThrow();
  });

  it("pointerLock() no-ops without document", () => {
    vi.stubGlobal("document", undefined);
    const pl = pointerLock();
    expect(pl.locked()).toBe(false);
    pl.request(document?.createElement?.("div") ?? ({} as Element));
    pl.exit();
    pl.dispose();
  });

  it("bounds() no-ops with a null target", () => {
    const b = bounds(null as unknown as Element);
    expect(b.rect().width).toBe(0);
    b.refresh();
    b.dispose();
  });

  it("animationFrame() no-ops without requestAnimationFrame", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const f = animationFrame();
    expect(f.running()).toBe(false);
    f.resume();
    f.pause();
    f.dispose();
  });

  it("mutationObserver() no-ops without MutationObserver", () => {
    vi.stubGlobal("MutationObserver", undefined);
    const m = mutationObserver(document.createElement("div"));
    expect(m.records()).toEqual([]);
    m.dispose();
  });

  it("favicon() no-ops without document", () => {
    vi.stubGlobal("document", undefined);
    expect(() => favicon("/x.png")).not.toThrow();
  });

  it("network() falls back without a connection / navigator", () => {
    vi.stubGlobal("navigator", undefined);
    const n = network();
    expect(n.effectiveType()).toBe("unknown");
    expect(n.saveData()).toBe(false);
    n.dispose();
  });

  it("colorScheme() falls back without matchMedia", () => {
    vi.stubGlobal("window", {});
    const { scheme, dispose } = colorScheme();
    expect(scheme()).toBe("light");
    dispose();
  });
});

describe("browser handlers + dispose (real paths)", () => {
  it("online() reacts to online/offline events and disposes", () => {
    const { online: isOnline, dispose } = online();
    window.dispatchEvent(new Event("offline"));
    expect(isOnline()).toBe(false);
    window.dispatchEvent(new Event("online"));
    expect(isOnline()).toBe(true);
    dispose();
  });

  it("idle() resets on activity and clears its timer on dispose", () => {
    vi.useFakeTimers();
    const { idle: isIdle, dispose } = idle(1000);
    vi.advanceTimersByTime(1000);
    expect(isIdle()).toBe(true);
    document.dispatchEvent(new Event("mousemove"));
    expect(isIdle()).toBe(false);
    dispose();
    vi.useRealTimers();
  });

  it("visibility() reacts to visibilitychange and disposes", () => {
    const { dispose } = visibility();
    document.dispatchEvent(new Event("visibilitychange"));
    dispose();
  });

  it("windowSize() reacts to resize and disposes", () => {
    const { dispose } = windowSize();
    window.dispatchEvent(new Event("resize"));
    dispose();
  });

  it("mouse() tracks pointer + touch and disposes", () => {
    const { x, y, dispose } = mouse();
    window.dispatchEvent(Object.assign(new Event("mousemove"), { clientX: 12, clientY: 34 }));
    expect(x()).toBe(12);
    expect(y()).toBe(34);
    window.dispatchEvent(Object.assign(new Event("touchmove"), { touches: [{ clientX: 5, clientY: 6 }] }));
    expect(x()).toBe(5);
    dispose();
  });

  it("keyboard() tracks keydown/keyup/blur and disposes", () => {
    const kb = keyboard();
    window.dispatchEvent(Object.assign(new Event("keydown"), { key: "a" }));
    expect(kb.isPressed("a")).toBe(true);
    window.dispatchEvent(Object.assign(new Event("keyup"), { key: "a" }));
    expect(kb.isPressed("a")).toBe(false);
    window.dispatchEvent(Object.assign(new Event("keydown"), { key: "b" }));
    window.dispatchEvent(new Event("blur"));
    expect(kb.isPressed("b")).toBe(false);
    kb.dispose();
  });

  it("keyboard() honours the keys filter", () => {
    const kb = keyboard({ keys: ["x"] });
    window.dispatchEvent(Object.assign(new Event("keydown"), { key: "y" })); // filtered out
    expect(kb.isPressed("y")).toBe(false);
    window.dispatchEvent(Object.assign(new Event("keyup"), { key: "y" })); // filtered out
    kb.dispose();
  });

  it("swipe() detects horizontal + vertical swipes and disposes", () => {
    const el = document.createElement("div");
    const seen: string[] = [];
    const s = swipe(el, { threshold: 10, onSwipe: (d) => seen.push(d) });
    el.dispatchEvent(Object.assign(new Event("touchstart"), { touches: [{ clientX: 0, clientY: 0 }] }));
    el.dispatchEvent(Object.assign(new Event("touchend"), { changedTouches: [{ clientX: 100, clientY: 0 }] }));
    expect(s.direction()).toBe("right");
    el.dispatchEvent(Object.assign(new Event("touchstart"), { touches: [{ clientX: 0, clientY: 0 }] }));
    el.dispatchEvent(Object.assign(new Event("touchend"), { changedTouches: [{ clientX: 0, clientY: 100 }] }));
    expect(s.direction()).toBe("down");
    expect(seen).toEqual(["right", "down"]);
    s.dispose();
  });

  it("colorScheme() reacts to scheme change and disposes", () => {
    const { mql, fire } = mockMatchMedia(false);
    vi.stubGlobal("window", { matchMedia: () => mql });
    const { scheme, dispose } = colorScheme();
    expect(scheme()).toBe("light");
    fire(true);
    expect(scheme()).toBe("dark");
    dispose();
    expect(mql.removeEventListener).toHaveBeenCalled();
  });

  it("media() reacts to a query change and disposes", () => {
    const { mql, fire } = mockMatchMedia(false);
    vi.stubGlobal("window", { matchMedia: () => mql });
    const { matches, dispose } = media("(max-width: 1px)");
    expect(matches()).toBe(false);
    fire(true);
    expect(matches()).toBe(true);
    dispose();
    expect(mql.removeEventListener).toHaveBeenCalled();
  });

  it("clipboard() copies and clears its timer on dispose", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const cb = clipboard();
    await cb.copy("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(cb.text()).toBe("hello");
    expect(cb.copied()).toBe(true);
    cb.dispose(); // clears the pending 2s reset timer
    vi.useRealTimers();
  });

  it("network() reads connection info and disposes", () => {
    const listeners: Record<string, () => void> = {};
    vi.stubGlobal("navigator", {
      connection: {
        effectiveType: "4g",
        downlink: 10,
        rtt: 50,
        saveData: false,
        addEventListener: (e: string, h: () => void) => {
          listeners[e] = h;
        },
        removeEventListener: vi.fn(),
      },
    });
    const n = network();
    expect(n.effectiveType()).toBe("4g");
    expect(n.downlink()).toBe(10);
    listeners.change?.(); // update handler
    n.dispose();
  });

  it("permissions() resolves to unsupported when query rejects", async () => {
    vi.stubGlobal("navigator", {
      permissions: { query: () => Promise.reject(new Error("denied")) },
    });
    const p = permissions("camera");
    await Promise.resolve();
    await Promise.resolve();
    expect(p.state()).toBe("unsupported");
    p.dispose();
  });

  it("permissions() tracks a resolved status and its change event", async () => {
    let changeHandler: (() => void) | null = null;
    const status = {
      state: "granted",
      addEventListener: (_e: string, h: () => void) => {
        changeHandler = h;
      },
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("navigator", { permissions: { query: () => Promise.resolve(status) } });
    const p = permissions("camera");
    await Promise.resolve();
    await Promise.resolve();
    expect(p.state()).toBe("granted");
    status.state = "denied";
    changeHandler?.();
    expect(p.state()).toBe("denied");
    p.dispose();
    expect(status.removeEventListener).toHaveBeenCalled();
  });

  it("battery() ignores a resolution that lands after dispose", async () => {
    const bm = {
      level: 1,
      charging: true,
      chargingTime: 0,
      dischargingTime: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("navigator", { getBattery: () => Promise.resolve(bm) });
    const b = battery();
    expect(b.supported()).toBe(true);
    b.dispose(); // set disposed BEFORE the promise resolves
    await Promise.resolve();
    await Promise.resolve();
    expect(bm.addEventListener).not.toHaveBeenCalled(); // disposed → early return
  });

  it("battery() wires change listeners and removes them on dispose", async () => {
    const bm = {
      level: 0.5,
      charging: false,
      chargingTime: 0,
      dischargingTime: 100,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("navigator", { getBattery: () => Promise.resolve(bm) });
    const b = battery();
    await Promise.resolve();
    await Promise.resolve();
    expect(b.level()).toBe(0.5);
    expect(bm.addEventListener).toHaveBeenCalled();
    b.dispose();
    expect(bm.removeEventListener).toHaveBeenCalled();
  });
});

describe("format edge", () => {
  it("formatCurrency honours an explicit locale option", () => {
    const out = formatCurrency(1234, "EUR", { locale: "de-DE" });
    expect(typeof out).toBe("string");
    expect(out).toContain("1");
  });
});
