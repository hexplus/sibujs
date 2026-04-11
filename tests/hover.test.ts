import { describe, expect, it, vi } from "vitest";
import { hover } from "../src/ui/hover";

function makeEl() {
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

describe("hover", () => {
  it("starts not hovered and toggles on pointerenter/leave", () => {
    const { el, handlers } = makeEl();
    const h = hover(el);
    expect(h.hovered()).toBe(false);
    for (const fn of handlers["pointerenter"] || []) fn({} as Event);
    expect(h.hovered()).toBe(true);
    for (const fn of handlers["pointerleave"] || []) fn({} as Event);
    expect(h.hovered()).toBe(false);
  });

  it("dispose removes listeners", () => {
    const { el, handlers } = makeEl();
    const h = hover(el);
    h.dispose();
    expect(handlers["pointerenter"]?.length ?? 0).toBe(0);
    expect(handlers["pointerleave"]?.length ?? 0).toBe(0);
  });
});
