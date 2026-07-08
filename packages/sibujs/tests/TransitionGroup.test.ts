import { describe, expect, it, vi } from "vitest";
import { TransitionGroup } from "../src/ui/TransitionGroup";

function mockElement(id: string): HTMLElement {
  return {
    id,
    getBoundingClientRect: vi.fn(() => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON() {},
    })),
  } as unknown as HTMLElement;
}

describe("TransitionGroup", () => {
  it("calls enter callback when adding an element", () => {
    const enter = vi.fn();
    const group = TransitionGroup({ enter });

    const el = mockElement("a");
    group.add(el);

    expect(enter).toHaveBeenCalledWith(el);
  });

  it("calls leave callback when removing an element", async () => {
    const leave = vi.fn();
    const group = TransitionGroup({ leave });

    const el = mockElement("a");
    group.add(el);
    await group.remove(el);

    expect(leave).toHaveBeenCalledWith(el);
  });

  it("waits for async leave before resolving remove", async () => {
    const order: string[] = [];
    const leave = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("leave-done");
    });
    const group = TransitionGroup({ leave });

    const el = mockElement("a");
    group.add(el);
    await group.remove(el);
    order.push("remove-resolved");

    expect(order).toEqual(["leave-done", "remove-resolved"]);
  });

  it("tracks elements and calls enter/leave for differences", () => {
    const enter = vi.fn();
    const leave = vi.fn();
    const group = TransitionGroup({ enter, leave });

    const a = mockElement("a");
    const b = mockElement("b");
    const c = mockElement("c");

    // Initial track with [a, b]
    group.track([a, b]);
    expect(enter).toHaveBeenCalledWith(a);
    expect(enter).toHaveBeenCalledWith(b);

    enter.mockClear();

    // Track with [b, c] — a leaves, c enters
    group.track([b, c]);
    expect(leave).toHaveBeenCalledWith(a);
    expect(enter).toHaveBeenCalledWith(c);
    expect(enter).not.toHaveBeenCalledWith(b);
  });

  it("calls move callback when element positions change", () => {
    const move = vi.fn();
    const group = TransitionGroup({ move });

    const el = mockElement("a");
    // First track records initial position at (0,0)
    group.track([el]);

    // On the second track call, getBoundingClientRect will be called twice:
    // once to capture old position, then once to detect new position.
    // Return the old position first, then the new position.
    const getBounds = el.getBoundingClientRect as ReturnType<typeof vi.fn>;
    getBounds.mockReturnValueOnce({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON() {},
    });
    getBounds.mockReturnValueOnce({
      left: 50,
      top: 50,
      right: 150,
      bottom: 150,
      width: 100,
      height: 100,
      x: 50,
      y: 50,
      toJSON() {},
    });
    // Third call is for storing the final position
    getBounds.mockReturnValueOnce({
      left: 50,
      top: 50,
      right: 150,
      bottom: 150,
      width: 100,
      height: 100,
      x: 50,
      y: 50,
      toJSON() {},
    });

    group.track([el]);
    expect(move).toHaveBeenCalledWith(el);
  });

  it("works without any callbacks", () => {
    const group = TransitionGroup({});
    const el = mockElement("a");

    // Should not throw
    group.add(el);
    group.track([el]);
    group.remove(el);
  });
});
