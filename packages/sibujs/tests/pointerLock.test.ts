import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pointerLock } from "../src/browser/pointerLock";

describe("pointerLock", () => {
  let handlers: Record<string, EventListener[]>;
  let pointerLockElement: Element | null;
  let exitSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers = {};
    pointerLockElement = null;
    exitSpy = vi.fn(() => {
      pointerLockElement = null;
    });

    vi.stubGlobal("document", {
      get pointerLockElement() {
        return pointerLockElement;
      },
      exitPointerLock: exitSpy,
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

  it("starts unlocked", () => {
    const pl = pointerLock();
    expect(pl.locked()).toBe(false);
  });

  it("updates locked on pointerlockchange", () => {
    const pl = pointerLock();
    pointerLockElement = { tagName: "DIV" } as unknown as Element;
    for (const h of handlers["pointerlockchange"] || []) h({} as Event);
    expect(pl.locked()).toBe(true);
  });

  it("request() calls element.requestPointerLock", () => {
    const pl = pointerLock();
    const el = { requestPointerLock: vi.fn() } as unknown as Element;
    pl.request(el);
    expect(el.requestPointerLock).toHaveBeenCalled();
  });

  it("exit() forwards to document.exitPointerLock", () => {
    const pl = pointerLock();
    pl.exit();
    expect(exitSpy).toHaveBeenCalled();
  });

  it("dispose removes the listener", () => {
    const pl = pointerLock();
    pl.dispose();
    expect(handlers["pointerlockchange"]?.length ?? 0).toBe(0);
  });
});
