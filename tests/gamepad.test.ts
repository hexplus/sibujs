import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gamepad } from "../src/browser/gamepad";

describe("gamepad", () => {
  let rafCallbacks: ((ts: number) => void)[];
  let gamepads: Array<Gamepad | null>;
  let windowHandlers: Record<string, EventListener[]>;

  beforeEach(() => {
    rafCallbacks = [];
    gamepads = [];
    windowHandlers = {};

    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: (ts: number) => void) => {
        rafCallbacks.push(cb);
        return rafCallbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    vi.stubGlobal("navigator", {
      getGamepads: () => gamepads,
    });

    vi.stubGlobal("window", {
      addEventListener: vi.fn((event: string, handler: EventListener) => {
        (windowHandlers[event] ||= []).push(handler);
      }),
      removeEventListener: vi.fn((event: string, handler: EventListener) => {
        windowHandlers[event] = (windowHandlers[event] || []).filter((h) => h !== handler);
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pumpRaf() {
    const pending = rafCallbacks;
    rafCallbacks = [];
    for (const cb of pending) cb(0);
  }

  function makePad(index: number, id: string, buttonsPressed: boolean[]): Gamepad {
    return {
      index,
      id,
      connected: true,
      buttons: buttonsPressed.map((p) => ({ pressed: p, touched: p, value: p ? 1 : 0 })),
      axes: [0, 0],
      mapping: "standard",
      timestamp: 0,
      vibrationActuator: null,
      hapticActuators: [],
    } as unknown as Gamepad;
  }

  it("starts with no pads when none are connected", () => {
    const gp = gamepad();
    expect(gp.pads()).toEqual([]);
    gp.dispose();
  });

  it("polls snapshots when a gamepad is connected", () => {
    gamepads = [makePad(0, "Test Pad", [false])];
    const gp = gamepad();
    pumpRaf(); // initial poll
    const pads = gp.pads();
    expect(pads.length).toBe(1);
    expect(pads[0].id).toBe("Test Pad");
    expect(pads[0].buttons[0].pressed).toBe(false);
    gp.dispose();
  });

  it("updates the signal when a button state changes", () => {
    gamepads = [makePad(0, "P", [false])];
    const gp = gamepad();
    pumpRaf();
    expect(gp.pads()[0].buttons[0].pressed).toBe(false);
    gamepads = [makePad(0, "P", [true])];
    pumpRaf();
    expect(gp.pads()[0].buttons[0].pressed).toBe(true);
    gp.dispose();
  });

  it("dispose removes gamepad listeners", () => {
    const gp = gamepad();
    gp.dispose();
    expect(windowHandlers["gamepadconnected"]?.length ?? 0).toBe(0);
    expect(windowHandlers["gamepaddisconnected"]?.length ?? 0).toBe(0);
  });
});
