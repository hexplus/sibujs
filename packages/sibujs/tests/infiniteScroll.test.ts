import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { infiniteScroll } from "../src/ui/infiniteScroll";

let observerCallback: IntersectionObserverCallback | null = null;
let observedElements: Element[] = [];

class MockIntersectionObserver {
  callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observerCallback = callback;
  }

  observe(el: Element) {
    observedElements.push(el);
  }

  unobserve(el: Element) {
    observedElements = observedElements.filter((e) => e !== el);
  }

  disconnect() {
    observedElements = [];
  }
}

describe("infiniteScroll", () => {
  beforeEach(() => {
    observerCallback = null;
    observedElements = [];
    (globalThis as unknown as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
  });

  it("starts with loading false", () => {
    const { loading } = infiniteScroll({
      onLoadMore: vi.fn(async () => {}),
      hasMore: () => true,
    });
    expect(loading()).toBe(false);
  });

  it("triggers onLoadMore when sentinel intersects", async () => {
    const onLoadMore = vi.fn(async () => {});
    const { sentinelRef } = infiniteScroll({
      onLoadMore,
      hasMore: () => true,
    });

    // Set sentinel element to trigger observer creation
    sentinelRef.current = document.createElement("div");

    // Simulate intersection
    observerCallback?.([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver);

    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("does not trigger when hasMore returns false", () => {
    const onLoadMore = vi.fn(async () => {});
    const { sentinelRef } = infiniteScroll({
      onLoadMore,
      hasMore: () => false,
    });

    sentinelRef.current = document.createElement("div");

    observerCallback?.([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver);

    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("does not trigger when not intersecting", () => {
    const onLoadMore = vi.fn(async () => {});
    const { sentinelRef } = infiniteScroll({
      onLoadMore,
      hasMore: () => true,
    });

    sentinelRef.current = document.createElement("div");

    observerCallback?.([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver);

    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("disconnects observer on dispose", () => {
    const { sentinelRef, dispose } = infiniteScroll({
      onLoadMore: vi.fn(async () => {}),
      hasMore: () => true,
    });

    sentinelRef.current = document.createElement("div");
    expect(observedElements.length).toBe(1);

    dispose();
    expect(observedElements.length).toBe(0);
  });
});
