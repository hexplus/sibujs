import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispose, registerDisposer, stageReplaceChildren } from "../src/core/rendering/dispose";
import { type CommitSlot, commitWhenActive } from "../src/core/rendering/heldCommit";
import { div, span } from "../src/core/rendering/html";
import { lazy, Suspense } from "../src/core/rendering/lazy";
import { onLoaded, type Pending, pendingCount } from "../src/core/rendering/range";
import { type LifecycleScope, lifecycleScope } from "../src/core/signals/lifecycleScope";
import { signal } from "../src/core/signals/signal";
import {
  createRouter,
  destroyRouter,
  KeepAliveRoute,
  navigate,
  Outlet,
  Route,
  Suspense as RouterSuspense,
} from "../src/plugins/router";
import { captureFrozen, heldListenerCount, heldRootCount, structuralBinding } from "../src/reactivity/track-core";

// ---------------------------------------------------------------------------
// DOM operations are not callback-free: removing or inserting a custom element
// runs its `disconnectedCallback` / `connectedCallback` synchronously, before
// the operation returns. A commit must check again after every teardown call
// that may detach one — even a call that found nothing outgoing — and a
// renderer must record what it inserts before the insertion, so a disposal run
// from `connectedCallback` reaches it. Exactly one of insertion and discard
// happens, cleanup runs once, and nothing is left held, waiting or pending.
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

/** How the readiness registration at `at` settled: "done", "cancelled", or "pending". */
const outcome = (at: Node) => {
  const entry = settled.find((e) => e.at === at);
  return entry === undefined ? "pending" : entry.cancelled ? "cancelled" : "done";
};

/** No hold, wait or readiness registration is left behind. */
function expectNothingRetained() {
  expect(heldRootCount()).toBe(roots);
  expect(heldListenerCount()).toBeLessThanOrEqual(listeners);
  expect(pendingCount() - base).toBe(0);
}

let tags = 0;
interface Hooks {
  connected?: (el: HTMLElement) => void;
  disconnected?: (el: HTMLElement) => void;
}
/** A fresh custom element type whose reactions call `hooks`; returns its factory and reaction counts. */
function customElement(hooks: Hooks) {
  const tag = `x-commit-probe-${++tags}`;
  const counts = { connected: 0, disconnected: 0 };
  customElements.define(
    tag,
    class extends HTMLElement {
      connectedCallback() {
        counts.connected++;
        hooks.connected?.(this);
      }
      disconnectedCallback() {
        counts.disconnected++;
        hooks.disconnected?.(this);
      }
    },
  );
  return { make: () => document.createElement(tag), counts };
}

/** User work captured in a lifecycle scope: an effect, a watch and an owned cleanup on `tick`. */
function scopedWork() {
  const [tick, setTick] = signal(0);
  const rec = { scope: null as LifecycleScope | null, effectRuns: 0, watchRuns: 0, cleanup: vi.fn() };
  const capture = () => {
    const scope = lifecycleScope();
    rec.scope = scope;
    scope.effect(() => {
      tick();
      rec.effectRuns++;
    });
    scope.watch(tick, () => {
      rec.watchRuns++;
    });
    scope.own(() => rec.cleanup);
  };
  /** The scope ended, nothing reacts any more, the cleanup ran once. */
  const expectEnded = async () => {
    expect(rec.scope?.state()).toBe("ended");
    const effects = rec.effectRuns;
    const watches = rec.watchRuns;
    setTick((n) => n + 1);
    await flush();
    expect(rec.effectRuns).toBe(effects);
    expect(rec.watchRuns).toBe(watches);
    expect(rec.cleanup).toHaveBeenCalledTimes(1);
  };
  return { rec, capture, expectEnded };
}

// ---------------------------------------------------------------------------
// The commit driver with a staged replacement
// ---------------------------------------------------------------------------

describe("a staged replacement whose teardown detaches a custom element", () => {
  /**
   * Commit `incoming` into the empty `parent` (no outgoing nodes: teardown only
   * detaches the incoming node from `elsewhere`), gated on `owner`.
   */
  function stage(incoming: HTMLElement, opts: { owned?: () => boolean } = {}) {
    const parent = div();
    host.appendChild(parent);
    const owner = structuralBinding(() => {});
    const held = owner.run(() => captureFrozen());
    const slot: CommitSlot = { cancel: () => {} };
    const insert = vi.fn();
    const discard = vi.fn(() => dispose(incoming));
    const disposer = vi.fn();
    registerDisposer(incoming, disposer);
    const swap = stageReplaceChildren(parent, [incoming]);
    const run = () =>
      commitWhenActive(slot, {
        held,
        node: incoming,
        owned: opts.owned,
        teardown: swap.teardown,
        insert: () => {
          insert();
          swap.insert();
        },
        discard,
      });
    return { parent, owner, slot, insert, discard, disposer, run };
  }

  it("a disconnection cancelling the commit discards it once; nothing is inserted", () => {
    let slot!: CommitSlot;
    const ce = customElement({ disconnected: () => slot.cancel() });
    const incoming = ce.make();
    host.appendChild(incoming);
    const s = stage(incoming);
    slot = s.slot;
    s.run();
    expect(ce.counts.disconnected).toBe(1);
    expect(s.discard).toHaveBeenCalledTimes(1);
    expect(s.insert).not.toHaveBeenCalled();
    expect(s.disposer).toHaveBeenCalledTimes(1);
    expect(s.parent.childNodes.length).toBe(0);
    expect(incoming.isConnected).toBe(false);
    expectNothingRetained();
  });

  it("a disconnection pausing the lifecycle holds the result; it is inserted once on the resume", async () => {
    let owner!: ReturnType<typeof structuralBinding>;
    const ce = customElement({ disconnected: () => owner.freeze?.() });
    const incoming = ce.make();
    host.appendChild(incoming);
    const s = stage(incoming);
    owner = s.owner;
    s.run();
    expect(s.insert).not.toHaveBeenCalled();
    expect(s.parent.childNodes.length).toBe(0);
    expect(heldRootCount()).toBe(roots + 1);
    owner.thaw?.();
    await flush();
    expect(s.insert).toHaveBeenCalledTimes(1);
    expect(s.discard).not.toHaveBeenCalled();
    expect(s.disposer).not.toHaveBeenCalled();
    expect(s.parent.firstChild).toBe(incoming);
    expect(ce.counts).toEqual({ connected: 2, disconnected: 1 });
    expectNothingRetained();
  });

  it("a disconnection ending the lifecycle discards it once; nothing is inserted", async () => {
    let owner!: ReturnType<typeof structuralBinding>;
    const ce = customElement({ disconnected: () => owner.stop() });
    const incoming = ce.make();
    host.appendChild(incoming);
    const s = stage(incoming);
    owner = s.owner;
    s.run();
    await flush();
    expect(s.insert).not.toHaveBeenCalled();
    expect(s.discard).toHaveBeenCalledTimes(1);
    expect(s.disposer).toHaveBeenCalledTimes(1);
    expect(s.parent.childNodes.length).toBe(0);
    expectNothingRetained();
  });

  it("a disconnection disposing the renderer discards it once; nothing is inserted", () => {
    let alive = true;
    const ce = customElement({ disconnected: () => (alive = false) });
    const incoming = ce.make();
    host.appendChild(incoming);
    const s = stage(incoming, { owned: () => alive });
    s.run();
    expect(s.insert).not.toHaveBeenCalled();
    expect(s.discard).toHaveBeenCalledTimes(1);
    expect(s.disposer).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });

  it("repeated disconnections pausing it each time: held through every one, inserted once", async () => {
    let owner!: ReturnType<typeof structuralBinding>;
    let pauses = 3;
    const ce = customElement({
      disconnected: () => {
        if (pauses-- > 0) owner.freeze?.();
      },
    });
    const incoming = ce.make();
    const elsewhere = div();
    host.appendChild(elsewhere);
    elsewhere.appendChild(incoming);
    const s = stage(incoming);
    owner = s.owner;
    s.run();
    for (let i = 0; i < 3; i++) {
      expect(s.insert).not.toHaveBeenCalled();
      expect(heldRootCount()).toBe(roots + 1);
      // Put back where it came from: the next teardown detaches it again.
      elsewhere.appendChild(incoming);
      owner.thaw?.();
      await flush();
    }
    expect(s.insert).toHaveBeenCalledTimes(1);
    expect(s.discard).not.toHaveBeenCalled();
    expect(s.parent.firstChild).toBe(incoming);
    expect(ce.counts.disconnected).toBe(4);
    expectNothingRetained();
  });

  it("an incoming node inside the outgoing content is kept; only the outgoing content is disposed", () => {
    const ce = customElement({});
    const incoming = ce.make();
    const old = div({ class: "old" });
    const oldCleanup = vi.fn();
    registerDisposer(old, oldCleanup);
    old.appendChild(incoming);
    const parent = div();
    parent.appendChild(old);
    host.appendChild(parent);
    const owner = structuralBinding(() => {});
    const held = owner.run(() => captureFrozen());
    const keep = vi.fn();
    registerDisposer(incoming, keep);
    const swap = stageReplaceChildren(parent, [incoming]);
    const discard = vi.fn();
    commitWhenActive(
      { cancel: () => {} },
      { held, node: incoming, teardown: swap.teardown, insert: swap.insert, discard },
    );
    expect(oldCleanup).toHaveBeenCalledTimes(1);
    expect(keep).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(Array.from(parent.childNodes)).toEqual([incoming]);
    expect(ce.counts).toEqual({ connected: 2, disconnected: 1 });
  });

  it("an incoming node inside the outgoing content cancelling on disconnection: discarded once, outgoing disposed once", () => {
    let slot!: CommitSlot;
    const ce = customElement({ disconnected: () => slot.cancel() });
    const incoming = ce.make();
    const old = div({ class: "old" });
    const oldCleanup = vi.fn();
    registerDisposer(old, oldCleanup);
    old.appendChild(incoming);
    const parent = div();
    parent.appendChild(old);
    host.appendChild(parent);
    const owner = structuralBinding(() => {});
    const held = owner.run(() => captureFrozen());
    const incomingCleanup = vi.fn();
    registerDisposer(incoming, incomingCleanup);
    const swap = stageReplaceChildren(parent, [incoming]);
    const insert = vi.fn(swap.insert);
    const discard = vi.fn(() => dispose(incoming));
    slot = { cancel: () => {} };
    commitWhenActive(slot, { held, node: incoming, teardown: swap.teardown, insert, discard });
    expect(insert).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(incomingCleanup).toHaveBeenCalledTimes(1);
    // The commit is gone: whoever tears the content down next disposes it once.
    dispose(parent);
    expect(oldCleanup).toHaveBeenCalledTimes(1);
    expect(incomingCleanup).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// core lazy()
// ---------------------------------------------------------------------------

describe("core lazy()", () => {
  it("a connectedCallback disposing the container during the insertion ends the instance at once", async () => {
    const work = scopedWork();
    let container!: HTMLElement;
    const ce = customElement({ connected: () => dispose(container) });
    const rootCleanup = vi.fn();
    const Lazy = lazy(() =>
      Promise.resolve({
        default: () => {
          work.capture();
          const el = ce.make();
          registerDisposer(el, rootCleanup);
          return el;
        },
      }),
    );
    const owner = structuralBinding(() => {});
    container = owner.run(() => Lazy()) as HTMLElement;
    host.appendChild(container);
    await flush();
    expect(ce.counts.connected).toBe(1);
    expect(rootCleanup).toHaveBeenCalledTimes(1);
    await work.expectEnded();
    expect(outcome(container)).toBe("cancelled");
    // The owner lives on; disposing the container again changes nothing.
    dispose(container);
    expect(work.rec.cleanup).toHaveBeenCalledTimes(1);
    expect(rootCleanup).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });

  it("repeated mounts whose connection disposes them leave nothing behind", async () => {
    const work = scopedWork();
    let container!: HTMLElement;
    const ce = customElement({ connected: () => dispose(container) });
    const Lazy = lazy(() =>
      Promise.resolve({
        default: () => {
          work.capture();
          return ce.make();
        },
      }),
    );
    const scopes: LifecycleScope[] = [];
    for (let i = 0; i < 4; i++) {
      container = Lazy() as HTMLElement;
      host.appendChild(container);
      await flush();
      if (work.rec.scope) scopes.push(work.rec.scope);
    }
    // The first instance loaded the module; the rest were built cached and
    // connected only by the append, outside any commit.
    expect(scopes.length).toBe(4);
    expect(scopes.every((s) => s.state() === "ended")).toBe(true);
    expect(work.rec.cleanup).toHaveBeenCalledTimes(4);
    expectNothingRetained();
  });

  it("an attached root whose disconnection pauses the lifecycle is held, then inserted on the resume", async () => {
    const owner = structuralBinding(() => {});
    let first = true;
    const ce = customElement({
      disconnected: () => {
        if (first) owner.freeze?.();
        first = false;
      },
    });
    const shared = ce.make();
    host.appendChild(shared);
    const Lazy = lazy(() => Promise.resolve({ default: () => shared }));
    const container = owner.run(() => Lazy()) as HTMLElement;
    host.appendChild(container);
    await flush();
    expect(container.contains(shared)).toBe(false);
    expect(heldRootCount()).toBe(roots + 1);
    owner.thaw?.();
    await flush();
    expect(container.firstChild).toBe(shared);
    expect(outcome(container)).toBe("done");
    expectNothingRetained();
  });

  it("an insertion that throws ends the instance and shows the error view", async () => {
    const work = scopedWork();
    const Lazy = lazy(() =>
      Promise.resolve({
        default: () => {
          work.capture();
          // Not insertable into an element: the insertion throws.
          return document.implementation.createDocumentType("html", "", "") as unknown as HTMLElement;
        },
      }),
    );
    const container = Lazy() as HTMLElement;
    host.appendChild(container);
    await flush();
    expect(container.querySelector(".sibu-lazy-error")).not.toBeNull();
    await work.expectEnded();
    expect(outcome(container)).toBe("done");
    dispose(container);
    expect(work.rec.cleanup).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });
});

// ---------------------------------------------------------------------------
// core Suspense
// ---------------------------------------------------------------------------

describe("core Suspense", () => {
  it("content that is the fallback's own root, disposing the boundary on disconnection: discarded once, never re-inserted", async () => {
    let container!: HTMLElement;
    let fired = false;
    const ce = customElement({
      disconnected: () => {
        if (!fired) {
          fired = true;
          dispose(container);
        }
      },
    });
    const shared = ce.make();
    const cleanup = vi.fn();
    registerDisposer(shared, cleanup);
    const work = scopedWork();
    container = Suspense({
      nodes: () => shared,
      fallback: () => {
        work.capture();
        return shared;
      },
    });
    host.appendChild(container);
    expect(container.firstChild).toBe(shared);
    await flush();
    expect(container.childNodes.length).toBe(0);
    expect(shared.isConnected).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(ce.counts).toEqual({ connected: 1, disconnected: 1 });
    await work.expectEnded();
    expect(outcome(container)).toBe("cancelled");
    expectNothingRetained();
  });

  it("a content connectedCallback disposing the boundary ends the content once", async () => {
    let container!: HTMLElement;
    const ce = customElement({ connected: () => dispose(container) });
    const work = scopedWork();
    const fallback = scopedWork();
    const cleanup = vi.fn();
    container = Suspense({
      nodes: () => {
        work.capture();
        const el = ce.make();
        registerDisposer(el, cleanup);
        return el;
      },
      fallback: () => {
        fallback.capture();
        return span("…");
      },
    });
    host.appendChild(container);
    await flush();
    expect(cleanup).toHaveBeenCalledTimes(1);
    await work.expectEnded();
    await fallback.expectEnded();
    expect(outcome(container)).toBe("cancelled");
    dispose(container);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });
});

// ---------------------------------------------------------------------------
// Router renderers (the inherited bookkeeping gap)
// ---------------------------------------------------------------------------

describe("router renderers", () => {
  /** A route page: a custom element capturing scoped work, its root's disposals counted. */
  function page(hooks: Hooks) {
    const ce = customElement(hooks);
    const work = scopedWork();
    const cleanup = vi.fn();
    const component = () => {
      work.capture();
      const el = ce.make();
      registerDisposer(el, cleanup);
      return el;
    };
    return { component, work, cleanup, counts: ce.counts };
  }

  it("Route: a connectedCallback disposing the outlet releases the page once", async () => {
    let anchor!: Node;
    const p = page({ connected: () => dispose(anchor) });
    createRouter([{ path: "/a", component: p.component }], { mode: "memory", url: "/a" });
    anchor = Route();
    host.appendChild(anchor);
    await flush();
    expect(p.counts.connected).toBe(1);
    expect(p.cleanup).toHaveBeenCalledTimes(1);
    expect(host.childNodes.length).toBe(1);
    await p.work.expectEnded();
    expect(outcome(anchor)).toBe("cancelled");
    expectNothingRetained();
  });

  it("Route: a connectedCallback navigating away keeps the page until the next pass releases it once", async () => {
    let navigated = false;
    const a = page({
      connected: () => {
        if (navigated) return;
        navigated = true;
        void navigate("/b");
      },
    });
    createRouter(
      [
        { path: "/a", component: a.component },
        { path: "/b", component: () => div({ class: "b" }, "b") },
      ],
      { mode: "memory", url: "/a" },
    );
    const anchor = Route();
    host.appendChild(anchor);
    await flush();
    expect(host.querySelector(".b")).not.toBeNull();
    expect(a.cleanup).toHaveBeenCalledTimes(1);
    await a.work.expectEnded();
    expect(outcome(anchor)).toBe("done");
  });

  it("Route: an insertion that throws releases the page and shows the error view", async () => {
    const work = scopedWork();
    createRouter(
      [
        {
          path: "/a",
          component: () => {
            work.capture();
            return document.implementation.createDocumentType("html", "", "") as unknown as HTMLElement;
          },
        },
      ],
      { mode: "memory", url: "/a" },
    );
    const anchor = Route();
    host.appendChild(anchor);
    await flush();
    expect(host.querySelector(".route-error")).not.toBeNull();
    await work.expectEnded();
    expect(outcome(anchor)).toBe("done");
    dispose(anchor);
    expect(work.rec.cleanup).toHaveBeenCalledTimes(1);
  });

  it("Outlet: a connectedCallback disposing the nested outlet releases the child once", async () => {
    let outlet!: Node;
    const child = page({ connected: () => dispose(outlet) });
    createRouter(
      [
        {
          path: "/p",
          component: () => {
            outlet = Outlet();
            return div({ class: "layout" }, outlet);
          },
          children: [{ path: "/c", component: child.component }],
        },
      ],
      { mode: "memory", url: "/p/c" },
    );
    host.appendChild(Route());
    await flush();
    expect(child.counts.connected).toBe(1);
    expect(child.cleanup).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".layout")?.childNodes.length).toBe(1);
    await child.work.expectEnded();
    expect(outcome(outlet)).toBe("cancelled");
  });

  it("KeepAliveRoute: a connectedCallback disposing the outlet releases the page once", async () => {
    let anchor!: Node;
    const p = page({ connected: () => dispose(anchor) });
    createRouter([{ path: "/a", name: "a", component: p.component }], { mode: "memory", url: "/a" });
    anchor = KeepAliveRoute({ suspendInactive: true });
    host.appendChild(anchor);
    await flush();
    expect(p.counts.connected).toBe(1);
    expect(p.cleanup).toHaveBeenCalledTimes(1);
    expect(host.childNodes.length).toBe(1);
    await p.work.expectEnded();
    expect(outcome(anchor)).toBe("cancelled");
    expectNothingRetained();
  });

  it("KeepAliveRoute: a cached page whose disconnection disposes the outlet is not held again", async () => {
    let anchor!: Node;
    let armed = false;
    const p = page({ disconnected: () => armed && dispose(anchor) });
    createRouter(
      [
        { path: "/a", name: "a", component: p.component },
        { path: "/b", name: "b", component: () => div({ class: "b" }, "b") },
      ],
      { mode: "memory", url: "/a" },
    );
    anchor = KeepAliveRoute({ suspendInactive: true });
    host.appendChild(anchor);
    await flush();
    armed = true;
    await navigate("/b");
    await flush();
    expect(p.cleanup).toHaveBeenCalledTimes(1);
    await p.work.expectEnded();
    expect(host.querySelector(".b")).toBeNull();
    expectNothingRetained();
  });

  it("router Suspense: a connectedCallback disposing the boundary releases the content once", async () => {
    let anchor!: Node;
    const ce = customElement({ connected: () => dispose(anchor) });
    const cleanup = vi.fn();
    anchor = RouterSuspense({
      nodes: () =>
        Promise.resolve().then(() => {
          const el = ce.make();
          registerDisposer(el, cleanup);
          return el;
        }),
      fallback: () => span({ class: "fb" }, "…"),
    });
    host.appendChild(anchor);
    await flush();
    expect(ce.counts.connected).toBe(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(host.childNodes.length).toBe(1);
    expect(outcome(anchor)).toBe("cancelled");
    expectNothingRetained();
  });

  it("router Suspense: an insertion that throws shows the error view; the content is released", async () => {
    const cleanup = vi.fn();
    const anchor = RouterSuspense({
      nodes: () =>
        Promise.resolve().then(() => {
          const bad = document.implementation.createDocumentType("html", "", "");
          registerDisposer(bad, cleanup);
          return bad as unknown as HTMLElement;
        }),
    });
    host.appendChild(anchor);
    await flush();
    expect(host.querySelector(".suspense-error")).not.toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(outcome(anchor)).toBe("done");
  });
});
