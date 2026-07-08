import { describe, expect, it } from "vitest";
import { ref } from "../src/core/signals/ref";

describe("ref", () => {
  it("should hold an initial value", () => {
    const r = ref(42);
    expect(r.current).toBe(42);
  });

  it("should default to undefined when no initial value", () => {
    const r = ref<HTMLElement>();
    expect(r.current).toBeUndefined();
  });

  it("should allow mutation without triggering reactivity", () => {
    const r = ref(0);
    r.current = 10;
    expect(r.current).toBe(10);
  });

  it("should hold DOM elements", () => {
    const r = ref<HTMLDivElement | null>(null);
    const el = document.createElement("div");
    r.current = el;
    expect(r.current).toBe(el);
    expect(r.current.tagName).toBe("DIV");
  });
});
