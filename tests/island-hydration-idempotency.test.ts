import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDisposer } from "../src/core/rendering/dispose";
import { hydrateIslands, hydrateProgressively } from "../src/platform/ssr";

// ---------------------------------------------------------------------------
// Hydration is idempotent.
//
// THE INVARIANT UNDER TEST:
//
//   already hydrated  !=  candidate for hydration again
//
// `data-sibu-hydrated` is the authoritative marker, and every hydration API
// must respect it — including the one that wrote it. Calling a hydration API
// twice over overlapping roots (a common shape: a shell hydrates eagerly, then
// a later pass sweeps the page progressively) must be a no-op for anything
// already live.
//
// Regression origin: both `hydrateIslands` and `hydrateProgressively` selected
// candidates with `querySelectorAll("[data-sibu-island]")` and never read
// `data-sibu-hydrated`. Since the hydrated client tree deliberately KEEPS its
// island marker, a second pass re-selected it, re-ran the factory and
// `disposeAndReplace`d the live subtree — destroying component state and any
// listeners the first pass had installed.
// ---------------------------------------------------------------------------

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/** Controllable IntersectionObserver stub, mirroring the existing island tests. */
function stubIntersectionObserver() {
  const instances: Array<{ cb: IntersectionObserverCallback; targets: Element[]; disconnected: boolean }> = [];

  class FakeIO {
    cb: IntersectionObserverCallback;
    targets: Element[] = [];
    disconnected = false;
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb;
      instances.push(this);
    }
    observe(el: Element) {
      this.targets.push(el);
    }
    unobserve(el: Element) {
      this.targets = this.targets.filter((t) => t !== el);
    }
    disconnect() {
      this.disconnected = true;
      this.targets = [];
    }
    takeRecords() {
      return [];
    }
  }

  const original = (globalThis as Record<string, unknown>).IntersectionObserver;
  (globalThis as Record<string, unknown>).IntersectionObserver = FakeIO as unknown as typeof IntersectionObserver;

  return {
    instances,
    /** How many targets are currently being observed across live instances. */
    observedCount() {
      return instances.filter((i) => !i.disconnected).reduce((n, i) => n + i.targets.length, 0);
    },
    triggerAll() {
      for (const inst of instances) {
        if (inst.disconnected) continue;
        const entries = inst.targets.map((t) => ({ isIntersecting: true, target: t }) as IntersectionObserverEntry);
        if (entries.length) inst.cb(entries, inst as unknown as IntersectionObserver);
      }
    },
    restore() {
      (globalThis as Record<string, unknown>).IntersectionObserver = original;
    },
  };
}

/** An island factory that counts its instantiations and disposals. */
function countingIsland() {
  const counts = { creations: 0, disposals: 0 };
  const factory = () => {
    counts.creations++;
    const node = document.createElement("section");
    node.className = "island-body";
    node.textContent = `instance-${counts.creations}`;
    registerDisposer(node, () => {
      counts.disposals++;
    });
    return node;
  };
  return { counts, factory };
}

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
});

describe("hydrateIslands is idempotent", () => {
  it("a second pass does not re-create an already-hydrated island", () => {
    const { counts, factory } = countingIsland();
    host.innerHTML = '<div data-sibu-island="counter"></div>';

    hydrateIslands(host, { counter: factory });
    expect(counts.creations).toBe(1);
    const live = host.querySelector(".island-body");
    expect(live?.textContent).toBe("instance-1");
    expect((live as HTMLElement).getAttribute("data-sibu-hydrated")).toBe("true");

    hydrateIslands(host, { counter: factory });

    expect(counts.creations).toBe(1);
    expect(counts.disposals).toBe(0);
    // The very same node is still in the document — not a replacement.
    expect(host.querySelector(".island-body")).toBe(live);
  });

  it("hydrates only the unhydrated islands in a mixed root", () => {
    const a = countingIsland();
    const b = countingIsland();
    host.innerHTML = '<div data-sibu-island="a"></div>';

    hydrateIslands(host, { a: a.factory });
    expect(a.counts.creations).toBe(1);
    const firstLive = host.querySelector(".island-body");

    // A second, still-inert island appears later in the same root.
    const late = document.createElement("div");
    late.setAttribute("data-sibu-island", "b");
    host.appendChild(late);

    hydrateIslands(host, { a: a.factory, b: b.factory });

    expect(a.counts.creations).toBe(1); // untouched
    expect(a.counts.disposals).toBe(0);
    expect(b.counts.creations).toBe(1); // newly hydrated
    expect(host.querySelectorAll(".island-body")).toHaveLength(2);
    expect(host.querySelector(".island-body")).toBe(firstLive);
  });
});

describe("hydrateProgressively is idempotent", () => {
  let io: ReturnType<typeof stubIntersectionObserver>;

  beforeEach(() => {
    io = stubIntersectionObserver();
  });
  afterEach(() => {
    io.restore();
  });

  it("does not observe an island that is already hydrated", async () => {
    const { counts, factory } = countingIsland();
    host.innerHTML = '<div data-sibu-island="counter"></div>';

    const stopFirst = hydrateProgressively(host, { counter: factory });
    io.triggerAll();
    await settle();
    expect(counts.creations).toBe(1);
    const live = host.querySelector(".island-body");

    // A second progressive pass must find nothing left to do.
    const observedBefore = io.observedCount();
    const stopSecond = hydrateProgressively(host, { counter: factory });
    expect(io.observedCount()).toBe(observedBefore);

    io.triggerAll();
    await settle();

    expect(counts.creations).toBe(1);
    expect(counts.disposals).toBe(0);
    expect(host.querySelector(".island-body")).toBe(live);

    stopFirst();
    stopSecond();
  });

  it("a no-op second pass's cleanup does not dispose the first pass's island", async () => {
    const { counts, factory } = countingIsland();
    host.innerHTML = '<div data-sibu-island="counter"></div>';

    const stopFirst = hydrateProgressively(host, { counter: factory });
    io.triggerAll();
    await settle();
    expect(counts.creations).toBe(1);

    const stopSecond = hydrateProgressively(host, { counter: factory });
    // Only the owner that actually installed something may tear it down.
    stopSecond();
    await settle();

    expect(counts.disposals).toBe(0);
    expect(host.querySelector(".island-body")?.textContent).toBe("instance-1");
    stopFirst();
  });

  it("still hydrates islands that are genuinely inert", async () => {
    const { counts, factory } = countingIsland();
    host.innerHTML = '<div data-sibu-island="counter"></div>';

    const stop = hydrateProgressively(host, { counter: factory });
    io.triggerAll();
    await settle();

    expect(counts.creations).toBe(1);
    expect(host.querySelector(".island-body")).not.toBeNull();
    stop();
  });
});

describe("hydration APIs respect each other's marker", () => {
  let io: ReturnType<typeof stubIntersectionObserver>;
  beforeEach(() => {
    io = stubIntersectionObserver();
  });
  afterEach(() => {
    io.restore();
  });

  it("hydrateIslands then hydrateProgressively is a no-op for the hydrated island", async () => {
    const { counts, factory } = countingIsland();
    host.innerHTML = '<div data-sibu-island="counter"></div>';

    hydrateIslands(host, { counter: factory });
    expect(counts.creations).toBe(1);
    const live = host.querySelector(".island-body");

    const stop = hydrateProgressively(host, { counter: factory });
    io.triggerAll();
    await settle();

    expect(counts.creations).toBe(1);
    expect(counts.disposals).toBe(0);
    expect(host.querySelector(".island-body")).toBe(live);
    stop();
  });

  it("hydrateProgressively then hydrateIslands is a no-op for the hydrated island", async () => {
    const { counts, factory } = countingIsland();
    host.innerHTML = '<div data-sibu-island="counter"></div>';

    const stop = hydrateProgressively(host, { counter: factory });
    io.triggerAll();
    await settle();
    expect(counts.creations).toBe(1);
    const live = host.querySelector(".island-body");

    hydrateIslands(host, { counter: factory });

    expect(counts.creations).toBe(1);
    expect(counts.disposals).toBe(0);
    expect(host.querySelector(".island-body")).toBe(live);
    stop();
  });

  it("an island hydrated while a progressive trigger is pending is not re-instantiated", async () => {
    // The observer fires later than candidate selection, so the marker must be
    // re-checked at execution time, not only at discovery time.
    const { counts, factory } = countingIsland();
    host.innerHTML = '<div data-sibu-island="counter"></div>';

    const stop = hydrateProgressively(host, { counter: factory });
    // Another mechanism wins the race before the observer fires.
    hydrateIslands(host, { counter: factory });
    expect(counts.creations).toBe(1);
    const live = host.querySelector(".island-body");

    io.triggerAll();
    await settle();

    expect(counts.creations).toBe(1);
    expect(counts.disposals).toBe(0);
    expect(host.querySelector(".island-body")).toBe(live);
    stop();
  });
});
