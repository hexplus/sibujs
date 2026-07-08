import { describe, expect, it, vi } from "vitest";
import { type SwipeDirection, swipe } from "../src/browser/swipe";

function makeElement() {
  const handlers: Record<string, EventListener[]> = {};
  const el = {
    addEventListener: vi.fn((event: string, handler: EventListener) => {
      (handlers[event] ||= []).push(handler);
    }),
    removeEventListener: vi.fn((event: string, handler: EventListener) => {
      handlers[event] = (handlers[event] || []).filter((h) => h !== handler);
    }),
  } as unknown as HTMLElement;
  return { el, handlers };
}

function fireTouch(handlers: Record<string, EventListener[]>, type: "touchstart" | "touchend", x: number, y: number) {
  const event =
    type === "touchstart"
      ? { touches: [{ clientX: x, clientY: y }] }
      : { changedTouches: [{ clientX: x, clientY: y }] };
  for (const h of handlers[type] || []) h(event as unknown as Event);
}

describe("swipe", () => {
  it("detects horizontal swipes when threshold is exceeded", () => {
    const { el, handlers } = makeElement();
    const directions: SwipeDirection[] = [];
    const s = swipe(el, { threshold: 50, onSwipe: (d) => directions.push(d) });
    fireTouch(handlers, "touchstart", 0, 0);
    fireTouch(handlers, "touchend", 100, 10);
    expect(directions).toEqual(["right"]);
    expect(s.direction()).toBe("right");
  });

  it("detects vertical swipes", () => {
    const { el, handlers } = makeElement();
    const s = swipe(el, { threshold: 50 });
    fireTouch(handlers, "touchstart", 0, 0);
    fireTouch(handlers, "touchend", 10, -80);
    expect(s.direction()).toBe("up");
  });

  it("ignores swipes shorter than threshold", () => {
    const { el, handlers } = makeElement();
    const s = swipe(el, { threshold: 50 });
    fireTouch(handlers, "touchstart", 0, 0);
    fireTouch(handlers, "touchend", 20, 10);
    expect(s.direction()).toBe(null);
  });

  it("dispose removes listeners", () => {
    const { el, handlers } = makeElement();
    const s = swipe(el);
    s.dispose();
    expect(handlers["touchstart"]?.length ?? 0).toBe(0);
    expect(handlers["touchend"]?.length ?? 0).toBe(0);
  });
});
