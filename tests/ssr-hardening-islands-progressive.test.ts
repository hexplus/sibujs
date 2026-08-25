/**
 * Progressive island activation lifecycle.
 *
 * Governing invariant (§75): an island has a single activation lifetime.
 *
 *   INERT → WAITING → ACTIVATING → ACTIVE
 *              ↓            ↓
 *           DISPOSED     DISPOSED
 *
 * Never DISPOSED → ACTIVE, and never ACTIVE → ACTIVE again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { div } from "../src/core/rendering/html";
import { lazyIsland, mountIslands, registerIsland, unregisterIsland } from "../src/platform/islands";
import { hydrateProgressively } from "../src/platform/ssr";

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const macrotask = () => new Promise((r) => setTimeout(r, 5));

/** Install a controllable IntersectionObserver stub; returns a trigger. */
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
    /** Fire an intersection for every observed target. */
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

describe("progressive islands: mountIslands strategies", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  const makeIsland = (name: string, strategy: string, extra: Record<string, string> = {}) => {
    const el = document.createElement("div");
    el.setAttribute("data-sibu-island", name);
    el.setAttribute("data-sibu-load", strategy);
    for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
    host.appendChild(el);
    return el;
  };

  it("activates a `load` island exactly once", async () => {
    const setup = vi.fn();
    registerIsland("load-a", setup);
    makeIsland("load-a", "load");

    const cleanup = mountIslands(host);
    await settle();

    expect(setup).toHaveBeenCalledTimes(1);

    cleanup();
    unregisterIsland("load-a");
  });

  it("activates an `idle` island exactly once", async () => {
    const setup = vi.fn();
    registerIsland("idle-a", setup);
    makeIsland("idle-a", "idle");

    const cleanup = mountIslands(host);
    await macrotask();
    await settle();

    expect(setup).toHaveBeenCalledTimes(1);

    cleanup();
    unregisterIsland("idle-a");
  });

  it("activates a `visible` island once, and only after intersection", async () => {
    const io = stubIntersectionObserver();
    try {
      const setup = vi.fn();
      registerIsland("vis-a", setup);
      makeIsland("vis-a", "visible");

      const cleanup = mountIslands(host);
      await settle();
      // Not visible yet — must stay inert.
      expect(setup).not.toHaveBeenCalled();

      io.triggerAll();
      await settle();
      expect(setup).toHaveBeenCalledTimes(1);

      // Re-entering the viewport must not activate a second time.
      io.triggerAll();
      await settle();
      expect(setup).toHaveBeenCalledTimes(1);

      cleanup();
      unregisterIsland("vis-a");
    } finally {
      io.restore();
    }
  });

  it("activates an `interaction` island on first interaction only", async () => {
    const setup = vi.fn();
    registerIsland("int-a", setup);
    const el = makeIsland("int-a", "interaction");

    const cleanup = mountIslands(host);
    await settle();
    expect(setup).not.toHaveBeenCalled();

    el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await settle();
    expect(setup).toHaveBeenCalledTimes(1);

    // Subsequent interactions must not re-activate.
    el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    el.dispatchEvent(new Event("keydown", { bubbles: true }));
    await settle();
    expect(setup).toHaveBeenCalledTimes(1);

    cleanup();
    unregisterIsland("int-a");
  });

  it("activates at most once when several triggers race", async () => {
    const io = stubIntersectionObserver();
    try {
      const setup = vi.fn();
      registerIsland("race-a", setup);
      const el = makeIsland("race-a", "visible");

      const cleanup = mountIslands(host);

      // Visibility and interaction essentially simultaneously.
      io.triggerAll();
      el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      io.triggerAll();
      await settle();

      expect(setup).toHaveBeenCalledTimes(1);

      cleanup();
      unregisterIsland("race-a");
    } finally {
      io.restore();
    }
  });

  it("warns and skips an island with no registered factory", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    makeIsland("never-registered", "load");

    const cleanup = mountIslands(host);
    await settle();

    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("never-registered");
    cleanup();
  });

  it("does not activate an island that was already marked enhanced", async () => {
    const setup = vi.fn();
    registerIsland("done-a", setup);
    const el = makeIsland("done-a", "load");
    el.setAttribute("data-sibu-enhanced", "true");

    const cleanup = mountIslands(host);
    await settle();

    expect(setup).not.toHaveBeenCalled();
    cleanup();
    unregisterIsland("done-a");
  });

  it("isolates a throwing island setup from its siblings", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = vi.fn();
    registerIsland("bad-a", () => {
      throw new Error("island boom");
    });
    registerIsland("good-a", good);
    makeIsland("bad-a", "load");
    makeIsland("good-a", "load");

    const cleanup = mountIslands(host);
    await settle();

    expect(good).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalled();

    cleanup();
    unregisterIsland("bad-a");
    unregisterIsland("good-a");
  });

  it("does not raise an unhandled rejection when a lazy loader fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);

    // A failing dynamic import — the real-world case (a missing chunk).
    registerIsland(
      "lazy-bad",
      lazyIsland(() => Promise.reject(new Error("import failed"))),
    );
    makeIsland("lazy-bad", "load");

    const cleanup = mountIslands(host);
    await settle();
    await macrotask();

    process.off("unhandledRejection", onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
    // The failure is reported, not swallowed silently.
    expect(err).toHaveBeenCalled();

    cleanup();
    unregisterIsland("lazy-bad");
    err.mockRestore();
  });

  it("activates a lazy island from a module default export", async () => {
    const setup = vi.fn();
    registerIsland(
      "lazy-ok",
      lazyIsland(async () => ({ default: setup })),
    );
    makeIsland("lazy-ok", "load");

    const cleanup = mountIslands(host);
    await settle();
    await macrotask();

    expect(setup).toHaveBeenCalledTimes(1);

    cleanup();
    unregisterIsland("lazy-ok");
  });

  it("does not activate a lazy island whose loader resolves after cleanup", async () => {
    let resolveLoader!: (v: { default: () => void }) => void;
    const pending = new Promise<{ default: () => void }>((r) => {
      resolveLoader = r;
    });
    const setup = vi.fn();

    registerIsland(
      "lazy-late",
      lazyIsland(() => pending),
    );
    makeIsland("lazy-late", "load");

    const cleanup = mountIslands(host);
    await settle();
    // Tear down while the chunk is still in flight.
    cleanup();

    resolveLoader({ default: setup });
    await settle();
    await macrotask();

    // INVARIANT (§75): DISPOSED may never become ACTIVE. A lazy chunk landing
    // after teardown must not enhance, because the disposer it would return
    // has nowhere to go — `cleanup()` already drained the disposer list, so
    // the enhancement would be permanently unreachable.
    expect(setup).not.toHaveBeenCalled();

    unregisterIsland("lazy-late");
  });
});

describe("progressive islands: activation after removal", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  const makeIsland = (name: string, strategy: string) => {
    const el = document.createElement("div");
    el.setAttribute("data-sibu-island", name);
    el.setAttribute("data-sibu-load", strategy);
    host.appendChild(el);
    return el;
  };

  it("cleanup() cancels a pending idle activation", async () => {
    const setup = vi.fn();
    registerIsland("idle-cancel", setup);
    makeIsland("idle-cancel", "idle");

    const cleanup = mountIslands(host);
    cleanup(); // cancel before the idle callback fires

    await macrotask();
    await settle();

    expect(setup).not.toHaveBeenCalled();
    unregisterIsland("idle-cancel");
  });

  it("cleanup() cancels a pending visibility activation", async () => {
    const io = stubIntersectionObserver();
    try {
      const setup = vi.fn();
      registerIsland("vis-cancel", setup);
      makeIsland("vis-cancel", "visible");

      const cleanup = mountIslands(host);
      cleanup();

      io.triggerAll();
      await settle();

      expect(setup).not.toHaveBeenCalled();
      unregisterIsland("vis-cancel");
    } finally {
      io.restore();
    }
  });

  it("cleanup() removes interaction listeners so a later event cannot activate", async () => {
    const setup = vi.fn();
    registerIsland("int-cancel", setup);
    const el = makeIsland("int-cancel", "interaction");

    const cleanup = mountIslands(host);
    cleanup();

    el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await settle();

    expect(setup).not.toHaveBeenCalled();
    unregisterIsland("int-cancel");
  });

  it("does not leak listeners across 200 mount/cleanup cycles", async () => {
    const setup = vi.fn();
    registerIsland("cycle-a", setup);

    const added = new Map<string, number>();
    const removed = new Map<string, number>();
    const el = makeIsland("cycle-a", "interaction");

    const origAdd = el.addEventListener.bind(el);
    const origRemove = el.removeEventListener.bind(el);
    vi.spyOn(el, "addEventListener").mockImplementation(((type: string, ...rest: unknown[]) => {
      added.set(type, (added.get(type) ?? 0) + 1);
      return (origAdd as unknown as (...a: unknown[]) => unknown)(type, ...rest);
    }) as typeof el.addEventListener);
    vi.spyOn(el, "removeEventListener").mockImplementation(((type: string, ...rest: unknown[]) => {
      removed.set(type, (removed.get(type) ?? 0) + 1);
      return (origRemove as unknown as (...a: unknown[]) => unknown)(type, ...rest);
    }) as typeof el.removeEventListener);

    for (let i = 0; i < 200; i++) {
      el.removeAttribute("data-sibu-enhanced");
      el.removeAttribute("data-sibu-hydrated");
      const cleanup = mountIslands(host);
      cleanup();
    }

    for (const [type, addCount] of added) {
      expect(removed.get(type) ?? 0, `listener "${type}"`).toBeGreaterThanOrEqual(addCount);
    }

    unregisterIsland("cycle-a");
  });
});

describe("progressive islands: missing browser APIs", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  it("falls back to eager activation when IntersectionObserver is unavailable", async () => {
    const original = (globalThis as Record<string, unknown>).IntersectionObserver;
    (globalThis as Record<string, unknown>).IntersectionObserver = undefined;
    try {
      const setup = vi.fn();
      registerIsland("no-io", setup);
      const el = document.createElement("div");
      el.setAttribute("data-sibu-island", "no-io");
      el.setAttribute("data-sibu-load", "visible");
      host.appendChild(el);

      const cleanup = mountIslands(host);
      await settle();

      // Documented fallback: activate eagerly rather than never.
      expect(setup).toHaveBeenCalledTimes(1);
      cleanup();
      unregisterIsland("no-io");
    } finally {
      (globalThis as Record<string, unknown>).IntersectionObserver = original;
    }
  });

  it("falls back to a timeout when requestIdleCallback is unavailable", async () => {
    const original = (globalThis as Record<string, unknown>).requestIdleCallback;
    (globalThis as Record<string, unknown>).requestIdleCallback = undefined;
    try {
      const setup = vi.fn();
      registerIsland("no-ric", setup);
      const el = document.createElement("div");
      el.setAttribute("data-sibu-island", "no-ric");
      el.setAttribute("data-sibu-load", "idle");
      host.appendChild(el);

      const cleanup = mountIslands(host);
      await macrotask();
      await settle();

      expect(setup).toHaveBeenCalledTimes(1);
      cleanup();
      unregisterIsland("no-ric");
    } finally {
      (globalThis as Record<string, unknown>).requestIdleCallback = original;
    }
  });

  it("returns a no-op cleanup when there is no root", () => {
    expect(() => mountIslands(null)()).not.toThrow();
  });
});

describe("progressive islands: hydrateProgressively (SSR path)", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  const marker = (id: string) => {
    const el = document.createElement("div");
    el.setAttribute("data-sibu-island", id);
    el.textContent = `${id}-server`;
    host.appendChild(el);
    return el;
  };

  it("activates only on intersection, exactly once", async () => {
    const io = stubIntersectionObserver();
    try {
      marker("a");
      const factory = vi.fn(() => div({ id: "a-client" }, "a-client") as HTMLElement);

      const cleanup = hydrateProgressively(host, { a: factory });
      expect(factory).not.toHaveBeenCalled();

      io.triggerAll();
      expect(factory).toHaveBeenCalledTimes(1);
      expect(host.querySelector("#a-client")).not.toBeNull();

      io.triggerAll();
      expect(factory).toHaveBeenCalledTimes(1);

      cleanup();
    } finally {
      io.restore();
    }
  });

  it("preserves the island marker on the activated tree", async () => {
    const io = stubIntersectionObserver();
    try {
      marker("b");
      const cleanup = hydrateProgressively(host, { b: () => div("b-client") as HTMLElement });
      io.triggerAll();

      const activated = host.querySelector('[data-sibu-island="b"]');
      expect(activated).not.toBeNull();
      expect(activated?.getAttribute("data-sibu-hydrated")).toBe("true");
      cleanup();
    } finally {
      io.restore();
    }
  });

  it("cleanup() prevents a later intersection from activating", async () => {
    const io = stubIntersectionObserver();
    try {
      marker("c");
      const factory = vi.fn(() => div("c-client") as HTMLElement);

      const cleanup = hydrateProgressively(host, { c: factory });
      cleanup();

      io.triggerAll();
      expect(factory).not.toHaveBeenCalled();
    } finally {
      io.restore();
    }
  });

  it("ignores markers with no registered factory", () => {
    const io = stubIntersectionObserver();
    try {
      marker("unknown");
      const cleanup = hydrateProgressively(host, { other: () => div("x") as HTMLElement });
      io.triggerAll();

      expect(host.textContent).toContain("unknown-server");
      cleanup();
    } finally {
      io.restore();
    }
  });
});
