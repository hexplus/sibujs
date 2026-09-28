/**
 * `longPress` timer ownership.
 *
 * Invariants under test:
 *  - At most one long-press timer is pending; a new `pointerdown` never strands
 *    an older one where `cancel()` cannot reach it.
 *  - The press belongs to the pointer that started it: only that pointer's
 *    `pointerup` / `pointerleave` / `pointercancel` ends it, and a second
 *    pointer neither completes, cancels, nor restarts it.
 *  - After cleanup no timer owned by the action exists, so the callback never
 *    fires; cleanup is idempotent and removes every listener.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { longPress } from "../src/core/rendering/action";

/** A pointer event carrying `pointerId`, independent of `PointerEvent` support. */
function pointer(type: string, pointerId?: number): Event {
  const e = new Event(type);
  if (pointerId !== undefined) Object.defineProperty(e, "pointerId", { value: pointerId });
  return e;
}

describe("longPress: timer ownership and pointer cancellation", () => {
  let el: HTMLElement;
  let callback: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement("div");
    callback = vi.fn<() => void>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires exactly once for a sustained press", () => {
    const cleanup = longPress(el, { duration: 500, callback });
    el.dispatchEvent(pointer("pointerdown", 1));
    vi.advanceTimersByTime(499);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    el.dispatchEvent(pointer("pointerup", 1));
    expect(callback).toHaveBeenCalledTimes(1);
    cleanup?.();
  });

  it("does not fire when released before the duration", () => {
    const cleanup = longPress(el, { duration: 500, callback });
    el.dispatchEvent(pointer("pointerdown", 1));
    vi.advanceTimersByTime(300);
    el.dispatchEvent(pointer("pointerup", 1));
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
    cleanup?.();
  });

  it("does not fire after pointercancel", () => {
    const cleanup = longPress(el, { duration: 500, callback });
    el.dispatchEvent(pointer("pointerdown", 1));
    vi.advanceTimersByTime(300);
    el.dispatchEvent(pointer("pointercancel", 1));
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
    cleanup?.();
  });

  it("does not fire after pointerleave", () => {
    const cleanup = longPress(el, { duration: 500, callback });
    el.dispatchEvent(pointer("pointerdown", 1));
    el.dispatchEvent(pointer("pointerleave", 1));
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
    cleanup?.();
  });

  it("does not fire when disposed before the duration", () => {
    const cleanup = longPress(el, { duration: 500, callback });
    el.dispatchEvent(pointer("pointerdown", 1));
    cleanup?.();
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a repeated pointerdown does not strand the first timer", () => {
    const cleanup = longPress(el, { duration: 500, callback });
    el.dispatchEvent(pointer("pointerdown", 1));
    vi.advanceTimersByTime(200);
    el.dispatchEvent(pointer("pointerdown", 1));
    expect(vi.getTimerCount()).toBe(1);

    // Released before the restarted press completes: nothing may fire —
    // including the first press's timeout at t=500.
    vi.advanceTimersByTime(200);
    el.dispatchEvent(pointer("pointerup", 1));
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
    cleanup?.();
  });

  it("a repeated pointerdown restarts the press rather than firing twice", () => {
    const cleanup = longPress(el, { duration: 500, callback });
    el.dispatchEvent(pointer("pointerdown", 1));
    vi.advanceTimersByTime(200);
    el.dispatchEvent(pointer("pointerdown", 1));
    vi.advanceTimersByTime(499);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);
    cleanup?.();
  });

  it("a repeated pointerdown followed by dispose leaves no timer", () => {
    const cleanup = longPress(el, { duration: 500, callback });
    el.dispatchEvent(pointer("pointerdown"));
    el.dispatchEvent(pointer("pointerdown"));
    cleanup?.();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("a secondary pointer's up/leave/cancel neither cancels nor completes the primary press", () => {
    const cleanup = longPress(el, { duration: 500, callback });
    el.dispatchEvent(pointer("pointerdown", 1));
    vi.advanceTimersByTime(100);
    el.dispatchEvent(pointer("pointerup", 2));
    el.dispatchEvent(pointer("pointerleave", 2));
    el.dispatchEvent(pointer("pointercancel", 2));
    vi.advanceTimersByTime(399);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
    cleanup?.();
  });

  it("a secondary pointerdown does not restart or duplicate the primary press", () => {
    const cleanup = longPress(el, { duration: 500, callback });
    el.dispatchEvent(pointer("pointerdown", 1));
    vi.advanceTimersByTime(300);
    el.dispatchEvent(pointer("pointerdown", 2));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(200);
    expect(callback).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);
    // The secondary pointer releasing afterwards changes nothing.
    el.dispatchEvent(pointer("pointerup", 2));
    expect(callback).toHaveBeenCalledTimes(1);
    cleanup?.();
  });

  it("the primary pointer still cancels its own press while a secondary one is down", () => {
    const cleanup = longPress(el, { duration: 500, callback });
    el.dispatchEvent(pointer("pointerdown", 1));
    el.dispatchEvent(pointer("pointerdown", 2));
    el.dispatchEvent(pointer("pointerup", 1));
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
    cleanup?.();
  });

  it("repeated cleanup is harmless and removes every listener", () => {
    const remove = vi.spyOn(el, "removeEventListener");
    const cleanup = longPress(el, { duration: 500, callback });
    cleanup?.();
    cleanup?.();
    expect(new Set(remove.mock.calls.map(([type]) => type))).toEqual(
      new Set(["pointerdown", "pointerup", "pointerleave", "pointercancel"]),
    );
    el.dispatchEvent(pointer("pointerdown", 1));
    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
