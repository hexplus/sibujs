import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { div, span } from "../src/core/rendering/html";
import { lazy, Suspense } from "../src/core/rendering/lazy";
import { onLoaded, type Pending, pendingCount } from "../src/core/rendering/range";
import {
  createRouter,
  destroyRouter,
  KeepAliveRoute,
  navigate,
  Outlet,
  Route,
  type RouteDef,
  Suspense as RouterSuspense,
} from "../src/plugins/router";
import { heldListenerCount, heldRootCount, structuralBinding } from "../src/reactivity/track-core";

// ---------------------------------------------------------------------------
// Replacing content runs the outgoing content's teardown — application code —
// before the incoming content is inserted. That teardown can dispose the
// renderer, pause or end its lifecycle, or detach its anchor; the insertion
// must then not happen on the strength of a check made before it:
// - ownership ended: the incoming result is disposed once, nothing inserted,
//   and readiness is not settled as committed;
// - paused: the incoming result is kept until the resume, and the outgoing
//   teardown is not run again;
// - anchor detached: nothing is inserted into a stale parent.
// ---------------------------------------------------------------------------

let host: HTMLElement;
let base = 0;
let listeners = 0;
let roots = 0;
let settled: Pending[] = [];
let stopListening = (): void => {};

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  listeners = heldListenerCount();
  roots = heldRootCount();
  settled = [];
  stopListening = onLoaded((batch) => settled.push(...batch));
  // Taken with the listener above in place: it counts too.
  base = pendingCount();
});

afterEach(() => {
  stopListening();
  dispose(host);
  host.remove();
  destroyRouter();
  vi.restoreAllMocks();
});

const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** How the readiness registration at `at` settled: "done", "cancelled", or "pending". */
const outcome = (at: Node) => {
  const entry = settled.find((e) => e.at === at);
  return entry === undefined ? "pending" : entry.cancelled ? "cancelled" : "done";
};

/** An element counting its disposals. */
function counted(cls: string) {
  const cleanup = vi.fn();
  const make = () => {
    const el = div({ class: cls }, cls);
    registerDisposer(el, cleanup);
    return el;
  };
  return { make, cleanup };
}

describe("core Suspense: the fallback's teardown", () => {
  function mount(onFallbackDispose: (container: HTMLElement) => void) {
    const owner = structuralBinding(() => {});
    const fallbackCleanup = vi.fn();
    const content = counted("content");
    let container!: HTMLElement;
    container = owner.run(() =>
      Suspense({
        nodes: content.make,
        fallback: () => {
          const el = span({ class: "fallback" }, "…");
          registerDisposer(el, () => {
            fallbackCleanup();
            onFallbackDispose(container);
          });
          return el;
        },
      }),
    );
    host.appendChild(container);
    return { owner, container, content, fallbackCleanup };
  }

  it("disposes the boundary: the content is disposed once, never inserted, readiness cancelled", async () => {
    const { container, content, fallbackCleanup } = mount((c) => dispose(c));
    await flush();
    expect(container.querySelector(".content")).toBeNull();
    expect(content.cleanup).toHaveBeenCalledTimes(1);
    expect(fallbackCleanup).toHaveBeenCalledTimes(1);
    expect(outcome(container)).toBe("cancelled");
    expect(pendingCount() - base).toBe(0);
    expect(heldRootCount()).toBe(roots);
  });

  it("pauses the lifecycle: the content waits for the resume; the teardown is not repeated", async () => {
    let owner!: ReturnType<typeof structuralBinding>;
    const m = mount(() => owner.freeze?.());
    owner = m.owner;
    await flush();
    expect(m.container.querySelector(".content")).toBeNull();
    expect(outcome(m.container)).toBe("pending");
    m.owner.thaw?.();
    await flush();
    expect(m.container.querySelector(".content")).not.toBeNull();
    expect(m.fallbackCleanup).toHaveBeenCalledTimes(1);
    expect(m.content.cleanup).not.toHaveBeenCalled();
    expect(outcome(m.container)).toBe("done");
    expect(heldRootCount()).toBe(roots);
    expect(heldListenerCount()).toBeLessThanOrEqual(listeners);
  });

  it("ends the lifecycle: the content is disposed once, never inserted", async () => {
    let owner!: ReturnType<typeof structuralBinding>;
    const m = mount(() => owner.stop());
    owner = m.owner;
    await flush();
    expect(m.container.querySelector(".content")).toBeNull();
    expect(m.content.cleanup).toHaveBeenCalledTimes(1);
    expect(outcome(m.container)).toBe("cancelled");
  });
});

describe("core lazy(): the placeholder's teardown", () => {
  function mount(onPlaceholderDispose: (container: HTMLElement) => void, reject = false) {
    const owner = structuralBinding(() => {});
    const page = counted("loaded");
    const load = deferred<{ default: () => HTMLElement }>();
    const container = owner.run(() =>
      lazy(() => (reject ? load.promise.then(() => Promise.reject(new Error("offline"))) : load.promise))(),
    ) as HTMLElement;
    host.appendChild(container);
    const placeholder = container.querySelector(".sibu-lazy-loading") as Node;
    registerDisposer(placeholder, () => onPlaceholderDispose(container));
    load.resolve({ default: page.make });
    return { owner, container, page };
  }

  it("disposes the container: the component is disposed once, never inserted", async () => {
    const { container, page } = mount((c) => dispose(c));
    await flush();
    expect(container.querySelector(".loaded")).toBeNull();
    expect(page.cleanup).toHaveBeenCalledTimes(1);
    expect(outcome(container)).toBe("cancelled");
  });

  it("pauses the lifecycle: the component waits for the resume", async () => {
    let owner!: ReturnType<typeof structuralBinding>;
    const m = mount(() => owner.freeze?.());
    owner = m.owner;
    await flush();
    expect(m.container.querySelector(".loaded")).toBeNull();
    m.owner.thaw?.();
    await flush();
    expect(m.container.querySelector(".loaded")).not.toBeNull();
    expect(m.page.cleanup).not.toHaveBeenCalled();
    expect(outcome(m.container)).toBe("done");
    expect(heldRootCount()).toBe(roots);
  });

  it("the error view: pausing defers it, disposing the container drops it", async () => {
    let owner!: ReturnType<typeof structuralBinding>;
    const paused = mount(() => owner.freeze?.(), true);
    owner = paused.owner;
    await flush();
    expect(paused.container.querySelector(".sibu-lazy-error")).toBeNull();
    paused.owner.thaw?.();
    await flush();
    expect(paused.container.querySelector(".sibu-lazy-error")).not.toBeNull();

    const gone = mount((c) => dispose(c), true);
    await flush();
    expect(gone.container.querySelector(".sibu-lazy-error")).toBeNull();
    expect(outcome(gone.container)).toBe("cancelled");
  });
});

describe("Route(): the outgoing page's teardown", () => {
  function mount(onLeave: (anchor: Node, owner: ReturnType<typeof structuralBinding>) => void, extra: RouteDef[] = []) {
    const owner = structuralBinding(() => {});
    const leaving = vi.fn();
    let anchor!: Node;
    const next = counted("page-b");
    const routes: RouteDef[] = [
      {
        path: "/a",
        name: "a",
        component: () => {
          const el = div({ class: "page-a" }, "a");
          registerDisposer(el, () => {
            leaving();
            onLeave(anchor, owner);
          });
          return el;
        },
      },
      { path: "/b", name: "b", component: next.make },
      ...extra,
    ];
    createRouter(routes, { mode: "memory", url: "/a" });
    anchor = owner.run(() => Route());
    host.appendChild(anchor);
    return { owner, anchor, next, leaving };
  }

  it("disposes the outlet: the replacement is disposed once and never inserted", async () => {
    const { next, leaving } = mount((anchor) => dispose(anchor));
    await flush();
    expect(host.querySelector(".page-a")).not.toBeNull();
    await navigate("/b");
    await flush();
    expect(leaving).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".page-b")).toBeNull();
    expect(next.cleanup).toHaveBeenCalledTimes(1);
    expect(host.childNodes.length).toBe(1);
    expect(heldRootCount()).toBe(roots);
  });

  it("pauses the lifecycle: the replacement waits for the resume; the teardown is not repeated", async () => {
    const { owner, next, leaving } = mount((_anchor, o) => o.freeze?.());
    await flush();
    await navigate("/b");
    await flush();
    expect(host.querySelector(".page-a")).toBeNull();
    expect(host.querySelector(".page-b")).toBeNull();
    owner.thaw?.();
    await flush();
    expect(host.querySelector(".page-b")).not.toBeNull();
    expect(leaving).toHaveBeenCalledTimes(1);
    expect(next.cleanup).not.toHaveBeenCalled();
    expect(heldRootCount()).toBe(roots);
  });

  it("ends the lifecycle: the replacement is disposed once and never inserted", async () => {
    const { next } = mount((_anchor, o) => o.stop());
    await flush();
    await navigate("/b");
    await flush();
    expect(host.querySelector(".page-b")).toBeNull();
    expect(next.cleanup).toHaveBeenCalledTimes(1);
  });

  it("detaches the outlet: nothing goes into the old parent; the page renders once re-attached", async () => {
    const { anchor, next } = mount((a) => a.parentNode?.removeChild(a));
    await flush();
    await navigate("/b");
    await flush();
    expect(host.querySelector(".page-b")).toBeNull();
    expect(next.cleanup).toHaveBeenCalledTimes(1);
    host.appendChild(anchor);
    await flush();
    expect(host.querySelector(".page-b")).not.toBeNull();
  });

  it("the error view: disposing the outlet in the teardown drops it", async () => {
    const { anchor } = mount(
      (a) => dispose(a),
      [
        {
          path: "/bad",
          name: "bad",
          component: () => {
            throw new Error("bad page");
          },
        },
      ],
    );
    await flush();
    await navigate("/bad");
    await flush();
    expect(host.querySelector(".route-error")).toBeNull();
    expect(anchor.parentNode).toBe(host);
    expect(host.childNodes.length).toBe(1);
  });

  it("the error view: detaching the outlet in the teardown holds it for the attach", async () => {
    const { anchor } = mount(
      (a) => a.parentNode?.removeChild(a),
      [
        {
          path: "/bad",
          name: "bad",
          component: () => {
            throw new Error("bad page");
          },
        },
      ],
    );
    await flush();
    await navigate("/bad");
    await flush();
    expect(host.querySelector(".route-error")).toBeNull();
    host.appendChild(anchor);
    await flush();
    expect(host.querySelector(".route-error")).not.toBeNull();
  });
});

describe("Outlet(): the outgoing child's teardown", () => {
  it("disposes the outlet: the replacement child is disposed once and never inserted", async () => {
    let outlet!: Node;
    const next = counted("page-y");
    createRouter(
      [
        {
          path: "/l",
          name: "l",
          component: () => {
            outlet = Outlet();
            return div({ class: "layout" }, outlet);
          },
          children: [
            {
              path: "/x",
              name: "x",
              component: () => {
                const el = div({ class: "page-x" }, "x");
                registerDisposer(el, () => dispose(outlet));
                return el;
              },
            },
            { path: "/y", name: "y", component: next.make },
          ],
        },
      ],
      { mode: "memory", url: "/l/x" },
    );
    host.appendChild(Route());
    await flush();
    expect(host.querySelector(".page-x")).not.toBeNull();
    await navigate("/l/y");
    await flush();
    expect(host.querySelector(".page-y")).toBeNull();
    expect(next.cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("KeepAliveRoute(): the outgoing view's teardown", () => {
  it("disposes the outlet: the replacement is disposed once and never inserted", async () => {
    let anchor!: Node;
    const next = counted("page-b");
    createRouter(
      [
        {
          path: "/a",
          name: "a",
          component: () => {
            const el = div({ class: "page-a" }, "a");
            registerDisposer(el, () => dispose(anchor));
            return el;
          },
        },
        { path: "/b", name: "b", component: next.make },
      ],
      { mode: "memory", url: "/a" },
    );
    // Nothing cached: the outgoing view is disposed on the way out.
    anchor = KeepAliveRoute({ include: [] });
    host.appendChild(anchor);
    await flush();
    expect(host.querySelector(".page-a")).not.toBeNull();
    await navigate("/b");
    await flush();
    expect(host.querySelector(".page-b")).toBeNull();
    expect(next.cleanup).toHaveBeenCalledTimes(1);
  });

  it("pauses the lifecycle: the replacement waits for the resume", async () => {
    const owner = structuralBinding(() => {});
    const next = counted("page-b");
    const leaving = vi.fn();
    createRouter(
      [
        {
          path: "/a",
          name: "a",
          component: () => {
            const el = div({ class: "page-a" }, "a");
            registerDisposer(el, () => {
              leaving();
              owner.freeze?.();
            });
            return el;
          },
        },
        { path: "/b", name: "b", component: next.make },
      ],
      { mode: "memory", url: "/a" },
    );
    host.appendChild(owner.run(() => KeepAliveRoute({ include: [] })));
    await flush();
    await navigate("/b");
    await flush();
    expect(host.querySelector(".page-b")).toBeNull();
    owner.thaw?.();
    await flush();
    expect(host.querySelector(".page-b")).not.toBeNull();
    expect(leaving).toHaveBeenCalledTimes(1);
    expect(next.cleanup).not.toHaveBeenCalled();
  });
});

describe("router Suspense: the fallback's teardown", () => {
  it("disposes the boundary: the content is disposed once and never inserted", async () => {
    let anchor!: Node;
    const content = counted("content");
    const load = deferred<HTMLElement>();
    anchor = RouterSuspense({
      nodes: () => load.promise,
      fallback: () => {
        const el = document.createElement("span");
        el.className = "fallback";
        registerDisposer(el, () => dispose(anchor));
        return el;
      },
    });
    host.appendChild(anchor);
    await flush();
    expect(host.querySelector(".fallback")).not.toBeNull();
    load.resolve(content.make());
    await flush();
    expect(host.querySelector(".content")).toBeNull();
    expect(content.cleanup).toHaveBeenCalledTimes(1);
    expect(outcome(anchor)).toBe("cancelled");
  });

  it("pauses the lifecycle: the content waits for the resume", async () => {
    const owner = structuralBinding(() => {});
    const content = counted("content");
    const load = deferred<HTMLElement>();
    const anchor = owner.run(() =>
      RouterSuspense({
        nodes: () => load.promise,
        fallback: () => {
          const el = document.createElement("span");
          el.className = "fallback";
          registerDisposer(el, () => owner.freeze?.());
          return el;
        },
      }),
    );
    host.appendChild(anchor);
    await flush();
    load.resolve(content.make());
    await flush();
    expect(host.querySelector(".content")).toBeNull();
    owner.thaw?.();
    await flush();
    expect(host.querySelector(".content")).not.toBeNull();
    expect(content.cleanup).not.toHaveBeenCalled();
    expect(outcome(anchor)).toBe("done");
    expect(heldRootCount()).toBe(roots);
  });
});
