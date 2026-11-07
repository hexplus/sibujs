import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { div, span } from "../src/core/rendering/html";
import { lazy, Suspense } from "../src/core/rendering/lazy";
import { pendingCount } from "../src/core/rendering/range";
import { type LifecycleScope, lifecycleScope } from "../src/core/signals/lifecycleScope";
import { withSSR } from "../src/core/ssr-context";
import { createRouter, destroyRouter, KeepAliveRoute, navigate } from "../src/plugins/router";
import { heldListenerCount, structuralBinding } from "../src/reactivity/track-core";

// ---------------------------------------------------------------------------
// Core `lazy()` and `Suspense()`:
// - construction is exception-safe: a readiness registration made for a
//   container that is never returned is released, and the error propagates;
// - framework-scheduled work (the loaded component, `nodes()`, the commit)
//   follows the lifecycle the renderer was created in: held while it is
//   paused, dropped if it ends.
// ---------------------------------------------------------------------------

let host: HTMLElement;
let base = 0;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  base = pendingCount();
});

afterEach(() => {
  dispose(host);
  host.remove();
  destroyRouter();
  vi.restoreAllMocks();
});

const flush = async (turns = 6) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Mod = { default: () => HTMLElement };

describe("exception-safe construction", () => {
  it("a synchronously throwing import propagates and leaves nothing registered, however often", () => {
    const Broken = lazy<HTMLElement>(() => {
      throw new Error("no chunk");
    });
    for (let i = 0; i < 5; i++) expect(() => Broken()).toThrow("no chunk");
    expect(pendingCount() - base).toBe(0);
  });

  it("a throwing Suspense fallback propagates and leaves nothing registered, however often", () => {
    for (let i = 0; i < 5; i++) {
      expect(() =>
        Suspense({
          nodes: () => div("content"),
          fallback: () => {
            throw new Error("bad fallback");
          },
        }),
      ).toThrow("bad fallback");
    }
    expect(pendingCount() - base).toBe(0);
  });

  it("a rejected import settles its registration once, and shows the error view", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = deferred<Mod>();
    const Lazy = lazy(() => load.promise);
    host.appendChild(Lazy());
    expect(pendingCount() - base).toBe(1);
    load.reject(new Error("offline"));
    await flush();
    expect(host.querySelector(".sibu-lazy-error")?.textContent).toContain("offline");
    expect(pendingCount() - base).toBe(0);
    dispose(host);
    expect(pendingCount() - base).toBe(0);
  });

  it("disposal during loading releases the registration; the late module renders nothing", async () => {
    const load = deferred<Mod>();
    const factory = vi.fn(() => span("loaded"));
    const Lazy = lazy(() => load.promise);
    const container = Lazy();
    host.appendChild(container);
    dispose(container);
    expect(pendingCount() - base).toBe(0);
    load.resolve({ default: factory });
    await flush();
    expect(factory).not.toHaveBeenCalled();
    expect(pendingCount() - base).toBe(0);
  });

  it("a server render registers nothing, and a throwing import still propagates", () => {
    withSSR(() => {
      const Lazy = lazy(() => new Promise<Mod>(() => {}));
      Lazy();
      Suspense({ nodes: () => div("content"), fallback: () => span("…") });
      expect(() =>
        lazy<HTMLElement>(() => {
          throw new Error("ssr chunk");
        })(),
      ).toThrow("ssr chunk");
    });
    expect(pendingCount() - base).toBe(0);
  });
});

describe("the loaded component follows the lifecycle the placeholder rendered in", () => {
  it("held while paused, built and committed on resume — re-checked at every notification", async () => {
    const load = deferred<Mod>();
    const factory = vi.fn(() => span({ class: "loaded" }, "loaded"));
    const Lazy = lazy(() => load.promise);
    const owner = structuralBinding(() => {});
    const container = owner.run(() => Lazy());
    host.appendChild(container);
    owner.freeze?.();
    load.resolve({ default: factory });
    await flush();
    expect(factory).not.toHaveBeenCalled();
    expect(container.querySelector(".sibu-lazy-loading")).not.toBeNull();
    // Resumed and paused again before anything ran: still held.
    owner.thaw?.();
    owner.freeze?.();
    await flush();
    expect(container.querySelector(".loaded")).toBeNull();
    owner.thaw?.();
    await flush();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".loaded")).not.toBeNull();
    expect(pendingCount() - base).toBe(0);
  });

  it("a component that pauses its own lifecycle is held, not committed, until the resume", async () => {
    const load = deferred<Mod>();
    const owner = structuralBinding(() => {});
    const Lazy = lazy(() => load.promise);
    const container = owner.run(() => Lazy());
    host.appendChild(container);
    load.resolve({
      default: () => {
        owner.freeze?.();
        return span({ class: "loaded" }, "loaded");
      },
    });
    await flush();
    expect(container.querySelector(".loaded")).toBeNull();
    owner.thaw?.();
    await flush();
    expect(container.querySelector(".loaded")).not.toBeNull();
  });

  it("ended first: the factory never runs, nothing stays registered, the module is still cached", async () => {
    const load = deferred<Mod>();
    const factory = vi.fn(() => span({ class: "loaded" }, "loaded"));
    const Lazy = lazy(() => load.promise);
    const owner = structuralBinding(() => {});
    host.appendChild(owner.run(() => Lazy()));
    owner.freeze?.();
    const listeners = heldListenerCount();
    load.resolve({ default: factory });
    await flush();
    owner.stop();
    await flush();
    expect(factory).not.toHaveBeenCalled();
    expect(pendingCount() - base).toBe(0);
    expect(heldListenerCount()).toBeLessThanOrEqual(listeners);
    // Cached: a later instance renders synchronously.
    const again = Lazy();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(again.className).not.toBe("sibu-lazy");
  });

  it("a rejection while paused is shown on resume, not while hidden", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = deferred<Mod>();
    const owner = structuralBinding(() => {});
    const container = owner.run(() => lazy(() => load.promise)());
    host.appendChild(container);
    owner.freeze?.();
    load.reject(new Error("offline"));
    await flush();
    expect(container.querySelector(".sibu-lazy-error")).toBeNull();
    owner.thaw?.();
    await flush();
    expect(container.querySelector(".sibu-lazy-error")).not.toBeNull();
  });

  it("a scope captured in the loaded component pauses with the lifecycle and ends with the container", async () => {
    const load = deferred<Mod>();
    let scope!: LifecycleScope;
    const owner = structuralBinding(() => {});
    const container = owner.run(() => lazy(() => load.promise)());
    host.appendChild(container);
    load.resolve({
      default: () => {
        scope = lifecycleScope();
        return span("loaded");
      },
    });
    await flush();
    expect(scope.state()).toBe("active");
    owner.freeze?.();
    expect(scope.state()).toBe("paused");
    owner.thaw?.();
    dispose(container);
    expect(scope.state()).toBe("ended");
  });
});

describe("Suspense builds and commits only while its lifecycle is active", () => {
  it("nodes() waits for the resume; a lazy inside it is held with it", async () => {
    const load = deferred<Mod>();
    const nodes = vi.fn(() => lazy(() => load.promise)() as HTMLElement);
    const owner = structuralBinding(() => {});
    const container = owner.run(() => Suspense({ nodes, fallback: () => span({ class: "fallback" }, "…") }));
    host.appendChild(container);
    owner.freeze?.();
    await flush();
    expect(nodes).not.toHaveBeenCalled();
    owner.thaw?.();
    await flush();
    expect(nodes).toHaveBeenCalledTimes(1);
    owner.freeze?.();
    load.resolve({ default: () => span({ class: "loaded" }, "loaded") });
    await flush();
    expect(container.querySelector(".loaded")).toBeNull();
    expect(container.querySelector(".fallback")).not.toBeNull();
    owner.thaw?.();
    await flush();
    expect(container.querySelector(".loaded")).not.toBeNull();
    expect(container.querySelector(".fallback")).toBeNull();
    expect(pendingCount() - base).toBe(0);
  });
});

describe("inside KeepAliveRoute({ suspendInactive: true })", () => {
  function setup(pageA: () => HTMLElement, max?: number) {
    createRouter(
      [
        { path: "/a", component: pageA, name: "a" },
        { path: "/b", component: () => div({ class: "page-b" }, "b"), name: "b" },
        { path: "/c", component: () => div({ class: "page-c" }, "c"), name: "c" },
      ],
      { mode: "memory", url: "/a" },
    );
    host.appendChild(KeepAliveRoute({ suspendInactive: true, max }));
  }

  it("a module resolving while the page is hidden is committed only when it is shown again", async () => {
    const load = deferred<Mod>();
    const factory = vi.fn(() => span({ class: "loaded" }, "loaded"));
    const Lazy = lazy(() => load.promise);
    setup(() => div({ class: "page-a" }, Lazy()));
    await flush();
    const pageA = host.querySelector(".page-a") as HTMLElement;
    await navigate("/b");
    await flush();
    load.resolve({ default: factory });
    await flush();
    expect(factory).not.toHaveBeenCalled();
    expect(pageA.querySelector(".loaded")).toBeNull();
    await navigate("/a");
    await flush();
    expect(host.querySelector(".page-a")).toBe(pageA);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(pageA.querySelector(".loaded")).not.toBeNull();
  });

  it("an evicted page never runs the factory of a module that resolves afterwards", async () => {
    const load = deferred<Mod>();
    const factory = vi.fn(() => span({ class: "loaded" }, "loaded"));
    const Lazy = lazy(() => load.promise);
    setup(() => div({ class: "page-a" }, Lazy()), 1);
    await flush();
    await navigate("/b");
    await flush();
    await navigate("/c");
    await flush();
    load.resolve({ default: factory });
    await flush();
    expect(factory).not.toHaveBeenCalled();
    expect(pendingCount() - base).toBe(0);
  });
});
