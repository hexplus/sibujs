/**
 * `Outlet()` ownership across user-code and async boundaries.
 *
 * Invariants under test:
 *  - An Outlet update may commit only if **both** its generation and its owning
 *    outlet are still current at the exact commit boundary.
 *  - Executing a user `component()` factory is itself an ownership boundary: the
 *    factory may synchronously navigate, dispose the owner, or otherwise
 *    invalidate the generation. An `await` is not the only way ownership moves.
 *  - A node created by a generation that no longer owns the Outlet is
 *    lifecycle-disposed, never merely dropped or detached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { createRouter, destroyRouter, navigate, Outlet, Route, setRoutes } from "../src/plugins/router";

const settle = async (n = 30) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
};

/** Observable lifecycle resources on a created node. */
interface Probe {
  el: HTMLElement;
  disposed: number;
  effectRuns: number;
  listenerCalls: number;
  bump: () => void;
  click: () => void;
}

function makeProbe(name: string): Probe {
  const el = document.createElement("div");
  el.textContent = name;
  el.dataset.probe = name;
  const [count, setCount] = signal(0);

  const probe: Probe = {
    el,
    disposed: 0,
    effectRuns: 0,
    listenerCalls: 0,
    bump: () => setCount(count() + 1),
    click: () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  };

  const stopEffect = effect(() => {
    count();
    probe.effectRuns++;
  });
  const onClick = () => {
    probe.listenerCalls++;
  };
  el.addEventListener("click", onClick);
  registerDisposer(el, () => {
    probe.disposed++;
    stopEffect();
    el.removeEventListener("click", onClick);
  });

  return probe;
}

/** Assert a probe is fully torn down, not merely detached. */
function expectFullyDisposed(probe: Probe, host: HTMLElement) {
  expect(host.contains(probe.el)).toBe(false);
  expect(probe.disposed).toBe(1);
  const runsBefore = probe.effectRuns;
  probe.bump();
  expect(probe.effectRuns).toBe(runsBefore);
  probe.click();
  expect(probe.listenerCalls).toBe(0);
}

/**
 * A component factory that builds a **fresh** probe on every call, the way a
 * real component does, and records each one.
 *
 * This matters: `Outlet`'s reactive `update` runs several passes per
 * navigation, so a factory returning one shared node would have a later pass
 * dispose the very node an earlier pass mounted. Per-call nodes keep the test
 * measuring ownership rather than node reuse.
 */
function probeFactory(name: string) {
  const probes: Probe[] = [];
  const create = () => {
    const p = makeProbe(name);
    probes.push(p);
    return p;
  };
  return {
    probes,
    create,
    /** The probe currently attached to `host`, if any. */
    mounted: (host: HTMLElement) => probes.filter((p) => host.contains(p.el)),
    /** Every probe this factory ever built must be disposed exactly once. */
    expectAllDisposed: (host: HTMLElement) => {
      expect(probes.length).toBeGreaterThan(0);
      for (const p of probes) expectFullyDisposed(p, host);
    },
  };
}

/** A parent layout that renders an Outlet. */
const layout = (id: string) => () => {
  const el = document.createElement("div");
  el.id = id;
  el.appendChild(Outlet());
  return el;
};

describe("Outlet ownership", () => {
  let host: HTMLElement;
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    host = document.createElement("div");
    document.body.appendChild(host);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    try {
      destroyRouter();
    } catch {
      /* already torn down by the test */
    }
    host.remove();
    vi.restoreAllMocks();
  });

  // Reproducer A (OUT-001)
  it("does not commit a child whose component() synchronously navigated away", async () => {
    const a = probeFactory("child-a");
    const b = probeFactory("child-b");

    setRoutes([
      {
        path: "/parent",
        component: layout("parent"),
        children: [
          {
            path: "/a",
            component: () => {
              // Arbitrary user code, running *after* the outlet's ownership
              // check and *before* its commit.
              const node = a.create().el;
              void navigate("/parent/b");
              return node;
            },
          },
          { path: "/b", component: () => b.create().el },
        ],
      },
    ]);
    host.appendChild(Route());

    await navigate("/parent/a");
    await settle();

    // The newer navigation owns the outlet.
    expect(b.mounted(host).length).toBe(1);
    // Every node the losing generation built is gone *and* fully torn down.
    a.expectAllDisposed(host);
  });

  // Reproducer B (OUT-002 / OUT-001)
  it("does not commit a child whose component() synchronously tore down the router", async () => {
    const a = probeFactory("child-a");

    setRoutes([
      {
        path: "/parent",
        component: layout("parent"),
        children: [
          {
            path: "/a",
            component: () => {
              // The supported lifecycle path for tearing the outlet's owner
              // down from inside user code.
              const node = a.create().el;
              destroyRouter();
              return node;
            },
          },
        ],
      },
    ]);
    host.appendChild(Route());

    await navigate("/parent/a");
    await settle();

    a.expectAllDisposed(host);
  });

  // Reproducer C (OUT-002) — the critical case.
  it("never invokes component() for a lazy load that resolves after teardown", async () => {
    const late = probeFactory("late");
    const factory = vi.fn(() => late.create().el);
    let releaseLoad!: () => void;
    const gate = new Promise<void>((r) => {
      releaseLoad = r;
    });

    setRoutes([
      {
        path: "/parent",
        component: layout("parent"),
        children: [
          {
            path: "/lazy",
            component: async () => {
              await gate;
              return { default: factory };
            },
          },
        ],
      },
    ]);
    const routeNode = host.appendChild(Route());

    await navigate("/parent/lazy");
    await settle();
    // Still pending — the gate has not been released.
    expect(factory).not.toHaveBeenCalled();

    // Tear the outlet down while the child load is in flight.
    dispose(routeNode);
    routeNode.parentNode?.removeChild(routeNode);

    releaseLoad();
    await settle();

    // The component loader validates a freshly-loaded module exactly once, by
    // calling it and checking it returns an Element. That probe belongs to the
    // loader's cache-fill, not to the outlet, and its node is disposed.
    //
    // What the outlet must *not* do is add a call of its own: ownership was
    // already lost, so its stale pass never reaches `component()`. Before the
    // fix this count was 3.
    expect(factory).toHaveBeenCalledTimes(1);

    // Nothing was inserted, and every node the factory produced is fully torn
    // down rather than merely dropped.
    expect(host.childNodes.length).toBe(0);
    for (const p of late.probes) expectFullyDisposed(p, host);
  });

  // Reproducer D (OUT-001) — pins the *second* ownership check specifically.
  it("disposes a node created by a component() that invalidated its own generation", async () => {
    const stale = probeFactory("stale");
    const fresh = probeFactory("fresh");

    setRoutes([
      {
        path: "/parent",
        component: layout("parent"),
        children: [
          {
            path: "/stale",
            component: () => {
              // Build the node *first*, then invalidate — so the node already
              // owns live lifecycle resources by the time ownership is lost.
              const node = stale.create().el;
              void navigate("/parent/fresh");
              return node;
            },
          },
          { path: "/fresh", component: () => fresh.create().el },
        ],
      },
    ]);
    host.appendChild(Route());

    await navigate("/parent/stale");
    await settle();

    expect(stale.probes.length).toBeGreaterThan(0);
    expect(fresh.mounted(host).length).toBe(1);
    stale.expectAllDisposed(host);
  });

  // ABA (§14)
  it("keeps the newest generation authoritative across an A -> B -> A cycle", async () => {
    const a = probeFactory("a");
    const b = probeFactory("b");

    setRoutes([
      {
        path: "/parent",
        component: layout("parent"),
        children: [
          { path: "/a", component: () => a.create().el },
          { path: "/b", component: () => b.create().el },
        ],
      },
    ]);
    host.appendChild(Route());

    await navigate("/parent/a");
    await navigate("/parent/b");
    await navigate("/parent/a");
    await settle();

    // A is the owner: exactly one of its nodes is mounted, and no B node is.
    expect(a.mounted(host).length).toBe(1);
    expect(b.mounted(host).length).toBe(0);
    // Every B node, and every superseded A node, is disposed exactly once.
    for (const p of b.probes) expectFullyDisposed(p, host);
    for (const p of a.probes.filter((x) => !host.contains(x.el))) expectFullyDisposed(p, host);
  });

  describe("normal behaviour is preserved", () => {
    it("renders a child through the Outlet", async () => {
      setRoutes([
        {
          path: "/parent",
          component: layout("parent"),
          children: [{ path: "/a", component: () => makeProbe("child-a").el }],
        },
      ]);
      host.appendChild(Route());

      await navigate("/parent/a");
      await settle();

      expect(host.querySelector("#parent")).not.toBe(null);
      expect(host.querySelector('[data-probe="child-a"]')).not.toBe(null);
    });

    it("renders a lazily loaded child", async () => {
      setRoutes([
        {
          path: "/parent",
          component: layout("parent"),
          children: [
            {
              path: "/lazy",
              component: async () => ({ default: () => makeProbe("child-lazy").el }),
            },
          ],
        },
      ]);
      host.appendChild(Route());

      await navigate("/parent/lazy");
      await settle();

      expect(host.querySelector('[data-probe="child-lazy"]')).not.toBe(null);
    });

    it("replaces the child and disposes the outgoing one exactly once", async () => {
      const a = probeFactory("child-a");
      const b = probeFactory("child-b");
      setRoutes([
        {
          path: "/parent",
          component: layout("parent"),
          children: [
            { path: "/a", component: () => a.create().el },
            { path: "/b", component: () => b.create().el },
          ],
        },
      ]);
      host.appendChild(Route());

      await navigate("/parent/a");
      await settle();
      expect(a.mounted(host).length).toBe(1);

      await navigate("/parent/b");
      await settle();

      expect(b.mounted(host).length).toBe(1);
      // Every A node is gone and fully torn down; the live B node is untouched.
      a.expectAllDisposed(host);
      expect(b.mounted(host)[0].disposed).toBe(0);
    });

    it("clears the child when navigating out of the nested area", async () => {
      const a = probeFactory("child-a");
      setRoutes([
        {
          path: "/parent",
          component: layout("parent"),
          children: [{ path: "/a", component: () => a.create().el }],
        },
        { path: "/flat", component: () => makeProbe("flat").el },
      ]);
      host.appendChild(Route());

      await navigate("/parent/a");
      await settle();
      expect(a.mounted(host).length).toBe(1);

      await navigate("/flat");
      await settle();

      a.expectAllDisposed(host);
    });

    it("follows a redirect into a nested child", async () => {
      setRoutes([
        { path: "/go", redirect: "/parent/a" },
        {
          path: "/parent",
          component: layout("parent"),
          children: [{ path: "/a", component: () => makeProbe("child-a").el }],
        },
      ]);
      host.appendChild(Route());

      await navigate("/go");
      await settle();

      expect(host.querySelector('[data-probe="child-a"]')).not.toBe(null);
    });

    it("settles correctly under rapid navigation", async () => {
      const factories = ["a", "b", "c"].map((n) => probeFactory(`child-${n}`));
      setRoutes([
        {
          path: "/parent",
          component: layout("parent"),
          children: factories.map((f, i) => ({
            path: `/${["a", "b", "c"][i]}`,
            component: () => f.create().el,
          })),
        },
      ]);
      host.appendChild(Route());

      await Promise.all([navigate("/parent/a"), navigate("/parent/b"), navigate("/parent/c")]);
      await settle();

      // Exactly one child is mounted, and it is the last-requested one.
      expect(host.querySelectorAll("[data-probe]").length).toBe(1);
      expect(factories[2].mounted(host).length).toBe(1);
    });
  });

  it("produces no unhandled rejection when a child load rejects after teardown", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => {
      unhandled.push(e.reason);
      e.preventDefault();
    };
    const onProcess = (reason: unknown) => unhandled.push(reason);
    window.addEventListener("unhandledrejection", onUnhandled as EventListener);
    process.on("unhandledRejection", onProcess);

    try {
      let rejectLoad!: (e: Error) => void;
      const gate = new Promise<never>((_, rej) => {
        rejectLoad = rej;
      });

      setRoutes([
        {
          path: "/parent",
          component: layout("parent"),
          children: [{ path: "/lazy", component: () => gate }],
        },
      ]);
      const routeNode = host.appendChild(Route());

      await navigate("/parent/lazy");
      await settle();

      dispose(routeNode);
      routeNode.parentNode?.removeChild(routeNode);

      rejectLoad(new Error("late child failure"));
      await settle();

      expect(unhandled).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled as EventListener);
      process.off("unhandledRejection", onProcess);
    }
  });
});
