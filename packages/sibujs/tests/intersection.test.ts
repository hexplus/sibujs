import { beforeEach, describe, expect, it } from "vitest";
import { intersection } from "../src/ui/intersection";

// Mock IntersectionObserver
class MockIntersectionObserver {
  callback: IntersectionObserverCallback;
  elements: Element[] = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe(element: Element) {
    this.elements.push(element);
  }

  unobserve(element: Element) {
    this.elements = this.elements.filter((e) => e !== element);
  }

  disconnect() {
    this.elements = [];
  }

  trigger(entries: Partial<IntersectionObserverEntry>[]) {
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;
});

describe("intersection", () => {
  it("should create intersection state", () => {
    const result = intersection();
    expect(result.isIntersecting()).toBe(false);
    expect(result.intersectionRatio()).toBe(0);
  });

  it("should observe an element", () => {
    const result = intersection();
    const el = document.createElement("div");
    result.observe(el);
    expect(typeof result.unobserve).toBe("function");
  });

  it("should cleanup on unobserve", () => {
    const result = intersection();
    const el = document.createElement("div");
    result.observe(el);
    result.unobserve();
    // Should not throw
  });
});
