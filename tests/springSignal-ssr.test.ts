// @vitest-environment node
//
// 26. springSignal() in bare Node (SSR): no window, no requestAnimationFrame.

import { describe, expect, it } from "vitest";
import { springSignal } from "../src/ui/springSignal";

describe("springSignal without animation frames", () => {
  it("constructs and snaps the setter to the target instead of throwing", () => {
    expect(typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame).toBe("undefined");
    const [value, set, dispose] = springSignal(0);
    expect(() => set(1)).not.toThrow();
    expect(value()).toBe(1);
    set(42);
    expect(value()).toBe(42);
    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
    set(7);
    expect(value()).toBe(42);
  });
});
