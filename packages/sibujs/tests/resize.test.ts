import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resize } from "../src/browser/resize";

describe("resize", () => {
  let observerCallback: ResizeObserverCallback;
  let observedElements: Element[];
  let disconnected: boolean;

  beforeEach(() => {
    observedElements = [];
    disconnected = false;

    vi.stubGlobal(
      "ResizeObserver",
      class MockResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          observerCallback = callback;
        }
        observe(el: Element) {
          observedElements.push(el);
        }
        unobserve(el: Element) {
          observedElements = observedElements.filter((e) => e !== el);
        }
        disconnect() {
          disconnected = true;
          observedElements = [];
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns initial width and height of 0", () => {
    const el = document.createElement("div");
    const { width, height } = resize(() => el);
    expect(width()).toBe(0);
    expect(height()).toBe(0);
  });

  it("updates width and height when element resizes", () => {
    const el = document.createElement("div");
    const { width, height } = resize(() => el);

    observerCallback([{ contentRect: { width: 300, height: 200 } } as ResizeObserverEntry], {} as ResizeObserver);

    expect(width()).toBe(300);
    expect(height()).toBe(200);
  });

  it("handles null target gracefully", () => {
    const { width, height } = resize(() => null);
    expect(width()).toBe(0);
    expect(height()).toBe(0);
  });

  it("cleans up on dispose", () => {
    const el = document.createElement("div");
    const { dispose } = resize(() => el);

    expect(observedElements).toContain(el);
    dispose();
    expect(disconnected).toBe(true);
  });
});
