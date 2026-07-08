import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { intersection, lazyLoad } from "../src/ui/intersection";

type Entry = Partial<IntersectionObserverEntry>;

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  options?: IntersectionObserverInit;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.options = options;
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve(el: Element) {
    this.observed = this.observed.filter((e) => e !== el);
  }
  disconnect() {
    this.disconnected = true;
    this.observed = [];
  }
  trigger(entries: Entry[]) {
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

beforeEach(() => {
  MockIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("intersection callback updates signals", () => {
  it("reflects isIntersecting and ratio from the observer entry", () => {
    const result = intersection({ threshold: 0.5 });
    const el = document.createElement("div");
    result.observe(el);

    const obs = MockIntersectionObserver.instances[0];
    expect(obs.options).toEqual({ threshold: 0.5 });

    obs.trigger([{ isIntersecting: true, intersectionRatio: 0.75 }]);
    expect(result.isIntersecting()).toBe(true);
    expect(result.intersectionRatio()).toBe(0.75);

    obs.trigger([{ isIntersecting: false, intersectionRatio: 0 }]);
    expect(result.isIntersecting()).toBe(false);
    expect(result.intersectionRatio()).toBe(0);
  });

  it("ignores an empty entries array", () => {
    const result = intersection();
    const el = document.createElement("div");
    result.observe(el);
    MockIntersectionObserver.instances[0].trigger([]);
    expect(result.isIntersecting()).toBe(false);
  });

  it("re-observing disconnects the previous observer", () => {
    const result = intersection();
    const a = document.createElement("div");
    const b = document.createElement("div");
    result.observe(a);
    result.observe(b);
    expect(MockIntersectionObserver.instances[0].disconnected).toBe(true);
    expect(MockIntersectionObserver.instances[1].disconnected).toBe(false);
  });

  it("unobserve disconnects and clears the element", () => {
    const result = intersection();
    const el = document.createElement("div");
    result.observe(el);
    result.unobserve();
    expect(MockIntersectionObserver.instances[0].disconnected).toBe(true);
    // Calling unobserve again is a no-op.
    expect(() => result.unobserve()).not.toThrow();
  });

  it("observe is a no-op when IntersectionObserver is undefined", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const result = intersection();
    const el = document.createElement("div");
    expect(() => result.observe(el)).not.toThrow();
    expect(result.isIntersecting()).toBe(false);
  });
});

describe("lazyLoad", () => {
  it("calls loader and disconnects when the element intersects", () => {
    const loader = vi.fn();
    const el = document.createElement("div");
    const cleanup = lazyLoad(el, loader, { rootMargin: "100px" });

    const obs = MockIntersectionObserver.instances[0];
    expect(obs.options).toEqual({ rootMargin: "100px" });

    obs.trigger([{ isIntersecting: false }]);
    expect(loader).not.toHaveBeenCalled();

    obs.trigger([{ isIntersecting: true }]);
    expect(loader).toHaveBeenCalledOnce();
    expect(obs.disconnected).toBe(true);

    cleanup();
  });

  it("cleanup disconnects the observer", () => {
    const loader = vi.fn();
    const el = document.createElement("div");
    const cleanup = lazyLoad(el, loader);
    cleanup();
    expect(MockIntersectionObserver.instances[0].disconnected).toBe(true);
  });

  it("calls loader immediately when IntersectionObserver is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const loader = vi.fn();
    const el = document.createElement("div");
    const cleanup = lazyLoad(el, loader);
    expect(loader).toHaveBeenCalledOnce();
    expect(() => cleanup()).not.toThrow();
  });
});
