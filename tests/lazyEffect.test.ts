import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signal } from "../src/core/signals/signal";
import { lazyEffect } from "../src/ui/lazyEffect";

// ---------------------------------------------------------------------------
// Controllable fake IntersectionObserver.
//
// jsdom (and the vitest jsdom env) does NOT provide IntersectionObserver, so
// by default lazyEffect takes its SSR/old-browser fallback path. To exercise
// the observe/disconnect logic we install a fake that lets each test trigger
// intersection callbacks manually.
// ---------------------------------------------------------------------------

interface FakeEntry {
  isIntersecting: boolean;
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: (entries: FakeEntry[]) => void;
  options: IntersectionObserverInit | undefined;
  observed: Element[] = [];
  disconnected = false;

  constructor(cb: (entries: FakeEntry[]) => void, options?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = options;
    FakeIntersectionObserver.instances.push(this);
  }

  observe(el: Element): void {
    this.observed.push(el);
  }

  unobserve(el: Element): void {
    this.observed = this.observed.filter((e) => e !== el);
  }

  disconnect(): void {
    this.disconnected = true;
    this.observed = [];
  }

  // Test helper — simulate the browser firing the observer callback.
  trigger(isIntersecting: boolean): void {
    this.callback([{ isIntersecting }]);
  }

  triggerEmpty(): void {
    this.callback([]);
  }
}

const g = globalThis as unknown as { IntersectionObserver?: unknown };
let originalIO: unknown;

function installFakeIO(): void {
  originalIO = g.IntersectionObserver;
  FakeIntersectionObserver.instances = [];
  g.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
}

function removeIO(): void {
  originalIO = g.IntersectionObserver;
  // Simulate an environment without IntersectionObserver (SSR / old browser).
  g.IntersectionObserver = undefined;
}

function lastObserver(): FakeIntersectionObserver {
  const list = FakeIntersectionObserver.instances;
  return list[list.length - 1];
}

describe("lazyEffect — fallback path (no IntersectionObserver)", () => {
  beforeEach(() => {
    removeIO();
  });
  afterEach(() => {
    g.IntersectionObserver = originalIO;
  });

  it("runs the effect immediately when IntersectionObserver is undefined", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    lazyEffect(el, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stays reactive in fallback mode and disposes via the returned function", () => {
    const el = document.createElement("div");
    const [n, setN] = signal(0);
    const fn = vi.fn(() => {
      n();
    });
    const dispose = lazyEffect(el, fn);
    expect(fn).toHaveBeenCalledTimes(1);

    setN(1);
    expect(fn).toHaveBeenCalledTimes(2);

    dispose();
    setN(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("returns a function in fallback mode", () => {
    const el = document.createElement("div");
    const dispose = lazyEffect(el, () => {});
    expect(typeof dispose).toBe("function");
  });
});

describe("lazyEffect — IntersectionObserver path", () => {
  beforeEach(() => {
    installFakeIO();
  });
  afterEach(() => {
    g.IntersectionObserver = originalIO;
  });

  it("does NOT run the effect until the element intersects", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    lazyEffect(el, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("observes the passed element", () => {
    const el = document.createElement("div");
    lazyEffect(el, () => {});
    expect(lastObserver().observed).toContain(el);
  });

  it("activates the effect when the element becomes visible", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    lazyEffect(el, fn);

    lastObserver().trigger(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("re-running stays reactive while visible", () => {
    const el = document.createElement("div");
    const [n, setN] = signal(0);
    const fn = vi.fn(() => {
      n();
    });
    lazyEffect(el, fn);

    lastObserver().trigger(true);
    expect(fn).toHaveBeenCalledTimes(1);

    setN(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("deactivates (disposes) the effect when the element leaves the viewport", () => {
    const el = document.createElement("div");
    const [n, setN] = signal(0);
    const fn = vi.fn(() => {
      n();
    });
    lazyEffect(el, fn);
    const obs = lastObserver();

    obs.trigger(true);
    expect(fn).toHaveBeenCalledTimes(1);

    obs.trigger(false);
    // Effect disposed — further signal changes must not re-run it.
    setN(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("re-creates the effect when re-entering the viewport", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    lazyEffect(el, fn);
    const obs = lastObserver();

    obs.trigger(true);
    expect(fn).toHaveBeenCalledTimes(1);

    obs.trigger(false);
    obs.trigger(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not double-activate when fired twice while already visible", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    lazyEffect(el, fn);
    const obs = lastObserver();

    obs.trigger(true);
    obs.trigger(true);
    // Second intersecting event while dispose is already set is a no-op.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("ignores a not-intersecting event when never activated", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    lazyEffect(el, fn);
    const obs = lastObserver();

    obs.trigger(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("ignores callbacks with no entries", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    lazyEffect(el, fn);
    const obs = lastObserver();

    obs.triggerEmpty();
    expect(fn).not.toHaveBeenCalled();
  });

  it("disconnect via returned dispose stops the observer", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    const dispose = lazyEffect(el, fn);
    const obs = lastObserver();

    dispose();
    expect(obs.disconnected).toBe(true);
  });

  it("after dispose, further intersection callbacks are ignored", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    const dispose = lazyEffect(el, fn);
    const obs = lastObserver();

    dispose();
    obs.trigger(true);
    expect(fn).not.toHaveBeenCalled();
  });

  it("dispose tears down an active effect", () => {
    const el = document.createElement("div");
    const [n, setN] = signal(0);
    const fn = vi.fn(() => {
      n();
    });
    const dispose = lazyEffect(el, fn);
    const obs = lastObserver();

    obs.trigger(true);
    expect(fn).toHaveBeenCalledTimes(1);

    dispose();
    setN(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses a default threshold of 0", () => {
    const el = document.createElement("div");
    lazyEffect(el, () => {});
    expect((lastObserver().options as { threshold?: number }).threshold).toBe(0);
  });

  it("merges user options over the default threshold", () => {
    const el = document.createElement("div");
    const root = document.createElement("div");
    lazyEffect(el, () => {}, { rootMargin: "50px", threshold: 0.5, root });
    const opts = lastObserver().options as IntersectionObserverInit;
    expect(opts.rootMargin).toBe("50px");
    expect(opts.threshold).toBe(0.5);
    expect(opts.root).toBe(root);
  });
});
