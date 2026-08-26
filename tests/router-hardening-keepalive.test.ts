/**
 * KeepAliveRoute temporal-ownership suite.
 *
 * The invariant under test:
 *
 *   Every KeepAlive update has one temporal ownership generation. Once
 *   superseded or disposed, that generation may never cache, mount, move, or
 *   otherwise commit a component.
 *
 * Ownership is deliberately NOT inferred from route *values* (pathname, query,
 * hash, or cache key). `same route value !== same navigation generation`: an
 * A → B → A round trip returns to the same values under a different generation,
 * and two navigations that differ only in query share a pathname entirely.
 *
 * Cache identity and async ownership are separate concepts here:
 *   - the cache key answers "which cached view is this?"
 *   - the update generation answers "may this async completion still commit?"
 *
 * Instrumentation note: `ComponentLoader.awaitComponent()` invokes a freshly
 * loaded factory once to validate that it returns an Element. Tests therefore
 * assert on which instances reach the DOM (via MutationObserver), never on the
 * raw factory call count, so they stay independent of that validation step.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { createRouter, destroyRouter, KeepAliveRoute, navigate } from "../src/plugins/router";

const settle = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};

/** A promise whose resolution the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Records every element that is actually attached to `host`, in order.
 *
 * Only elements carrying `data-instance` are recorded, so unrelated route
 * components (and the outlet's own comment anchor) stay out of the log.
 */
function attachmentLog(host: HTMLElement) {
  const attached: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof HTMLElement && node.hasAttribute("data-instance")) {
          attached.push(node.getAttribute("data-instance") as string);
        }
      }
    }
  });
  observer.observe(host, { childList: true });
  return {
    attached,
    /** Flush pending MutationObserver records into `attached`. */
    flush() {
      for (const record of observer.takeRecords()) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof HTMLElement && node.hasAttribute("data-instance")) {
            attached.push(node.getAttribute("data-instance") as string);
          }
        }
      }
      return attached;
    },
    stop: () => observer.disconnect(),
  };
}

/**
 * A component factory that stamps every instance it creates with a unique id
 * and records that instance's disposal.
 *
 * The FIRST invocation is not recorded. `ComponentLoader.doLoadComponent()`
 * calls every newly loaded factory once, purely to assert it returns an
 * Element, and discards the result — exactly once per route definition, since
 * the resolved factory is then memoised. That throwaway instance is never
 * attached and never disposed, but it is not a leak either: disposers live in a
 * `WeakMap` keyed by the node, so it is collected with the element. Counting it
 * would make every "created but not committed" assertion permanently red for
 * reasons that have nothing to do with KeepAlive ownership.
 */
function instrumented(label: string, created: string[], disposed: string[]) {
  let n = 0;
  return () => {
    const validationCall = n === 0;
    const id = `${label}-${++n}`;
    const el = document.createElement("div");
    el.setAttribute("data-instance", id);
    el.textContent = id;
    if (!validationCall) {
      created.push(id);
      registerDisposer(el, () => disposed.push(id));
    }
    return el;
  };
}

describe("router hardening: KeepAliveRoute temporal ownership", () => {
  let host: HTMLElement;
  let observer: ReturnType<typeof attachmentLog> | null;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    host = document.createElement("div");
    document.body.appendChild(host);
    observer = null;
  });

  afterEach(() => {
    observer?.stop();
    destroyRouter();
    host.remove();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // KA-001 — supersession by a navigation that shares this one's pathname
  // ─────────────────────────────────────────────────────────────────────────

  it("does not commit a lazy load superseded by a query-only navigation", async () => {
    const created: string[] = [];
    const disposed: string[] = [];
    const gate = deferred<{ default: () => HTMLElement }>();
    const Search = instrumented("search", created, disposed);

    createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/search", name: "search", component: async () => gate.promise },
      ],
      { keepAlive: 10 },
    );
    host.appendChild(KeepAliveRoute());
    await settle();

    observer = attachmentLog(host);

    // Generation 1 starts loading /search?q=a and parks on the gate.
    await navigate("/search?q=a");
    await settle();

    // Generation 2 supersedes it. Same pathname, different query — a
    // pathname-equality check cannot tell these two apart.
    await navigate("/search?q=b");
    await settle();

    // Only now does the lazy module arrive, for both parked generations.
    gate.resolve({ default: Search });
    await settle();

    expect(window.location.search).toBe("?q=b");

    // The superseded generation must not have put anything in the DOM.
    // Exactly one instance is committed: the one owned by generation 2.
    expect(observer.flush()).toHaveLength(1);
    expect(host.querySelectorAll("[data-instance]")).toHaveLength(1);

    // And no instance was created and then abandoned still-live.
    const live = created.filter((id) => !disposed.includes(id));
    expect(live).toHaveLength(1);
  });

  it("does not commit a lazy load superseded by a hash-only navigation", async () => {
    // KeepAlive cache identity includes the hash (see `cacheKey` in
    // KeepAliveRoute), so /docs#one and /docs#two are distinct cached views and
    // the same supersession rule must hold for them.
    const created: string[] = [];
    const disposed: string[] = [];
    const gate = deferred<{ default: () => HTMLElement }>();
    const Docs = instrumented("docs", created, disposed);

    createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/docs", name: "docs", component: async () => gate.promise },
      ],
      { keepAlive: 10 },
    );
    host.appendChild(KeepAliveRoute());
    await settle();

    observer = attachmentLog(host);

    await navigate("/docs#one");
    await settle();
    await navigate("/docs#two");
    await settle();

    gate.resolve({ default: Docs });
    await settle();

    expect(observer.flush()).toHaveLength(1);
    expect(host.querySelectorAll("[data-instance]")).toHaveLength(1);
    expect(created.filter((id) => !disposed.includes(id))).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // KA-001 — ABA: returning to the same route is a NEW generation
  // ─────────────────────────────────────────────────────────────────────────

  it("does not let a stale A generation replace the A that superseded it", async () => {
    const createdA: string[] = [];
    const disposedA: string[] = [];
    const gateA = deferred<{ default: () => HTMLElement }>();
    const A = instrumented("a", createdA, disposedA);
    const createdB: string[] = [];
    const disposedB: string[] = [];
    const B = instrumented("b", createdB, disposedB);

    createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", name: "a", component: async () => gateA.promise },
        { path: "/b", name: "b", component: B },
      ],
      { keepAlive: 10 },
    );
    host.appendChild(KeepAliveRoute());
    await settle();

    observer = attachmentLog(host);

    await navigate("/a"); // A₁ — parks on the gate
    await settle();
    await navigate("/b"); // B₂ — resolves synchronously
    await settle();
    await navigate("/a"); // A₃ — same route value, a NEW generation
    await settle();

    gateA.resolve({ default: A });
    await settle();

    // Final URL equality is NOT the evidence. The attachment order is: B₂ owned
    // the outlet while A₁ was in flight, and A₃ — not A₁ — took it back.
    // Under generation-free serialization A₁ simply held the outlet hostage for
    // its whole load, B₂ never rendered at all, and A₁ committed at the end.
    const attached = observer.flush();
    expect(attached).toHaveLength(2);
    expect(attached[0]).toMatch(/^b-/);
    expect(attached[1]).toMatch(/^a-/);

    expect(host.querySelectorAll("[data-instance]")).toHaveLength(1);
    expect(host.querySelector("[data-instance]")?.getAttribute("data-instance")).toMatch(/^a-/);

    // A₁ must not have built a node and left it alive and unowned.
    expect(createdA.filter((id) => !disposedA.includes(id))).toHaveLength(1);
    // B₂'s instance is cached, so it stays alive and undisposed.
    expect(disposedB).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // KA-002 — teardown during a lazy load
  // ─────────────────────────────────────────────────────────────────────────

  it("does not resurrect a disposed outlet when its lazy load resolves", async () => {
    const created: string[] = [];
    const disposed: string[] = [];
    const gate = deferred<{ default: () => HTMLElement }>();
    const Late = instrumented("late", created, disposed);

    createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/late", name: "late", component: async () => gate.promise },
      ],
      { keepAlive: 10 },
    );
    const anchor = KeepAliveRoute();
    host.appendChild(anchor);
    await settle();

    observer = attachmentLog(host);

    await navigate("/late");
    await settle();

    // The outlet is torn down while the module is still in flight.
    dispose(anchor);
    anchor.parentNode?.removeChild(anchor);
    await settle();

    gate.resolve({ default: Late });
    await settle();

    // No DOM insertion, no component resurrection.
    expect(observer.flush()).toHaveLength(0);
    expect(host.querySelectorAll("[data-instance]")).toHaveLength(0);
    expect(host.textContent).toBe("");

    // No node created by the dead generation is left alive holding effects.
    expect(created.filter((id) => !disposed.includes(id))).toHaveLength(0);
  });

  it("does not repopulate the cache after the outlet is disposed", async () => {
    // A cached entry recreated by a late load would be a pure leak: nothing can
    // ever reach it again, and its disposers would never run.
    const created: string[] = [];
    const disposed: string[] = [];
    const gate = deferred<{ default: () => HTMLElement }>();
    const Cached = instrumented("cached", created, disposed);

    createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/c", name: "c", component: async () => gate.promise },
      ],
      { keepAlive: ["c"] },
    );
    const anchor = KeepAliveRoute();
    host.appendChild(anchor);
    await settle();

    await navigate("/c");
    await settle();

    dispose(anchor);
    await settle();

    gate.resolve({ default: Cached });
    await settle();

    // Anything the dead generation built must be disposed, not cached.
    expect(created.filter((id) => !disposed.includes(id))).toHaveLength(0);
    expect(host.querySelectorAll("[data-instance]")).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // KA-002 — a node created before ownership is lost must be disposed
  // ─────────────────────────────────────────────────────────────────────────

  it("disposes a created node when ownership is lost during creation", async () => {
    // The commit boundary is what matters. If the factory itself tears the
    // outlet down (a mount-time side effect collapsing the parent layout), the
    // node already exists and has already registered its disposers — returning
    // early without disposing it leaks every one of them.
    const created: string[] = [];
    const disposed: string[] = [];
    const gate = deferred<{ default: () => HTMLElement }>();
    let anchor!: Node;

    let calls = 0;
    const SelfDestruct = () => {
      // First call is the loader's Element validation (see `instrumented`).
      // It must stay inert, or the outlet would be torn down before the real
      // commit path is ever exercised and the test would pass vacuously.
      const validationCall = calls++ === 0;
      const el = document.createElement("div");
      if (validationCall) return el;

      const id = `sd-${calls}`;
      created.push(id);
      el.setAttribute("data-instance", id);
      registerDisposer(el, () => disposed.push(id));
      // Ownership is revoked synchronously, after the node exists and has
      // already registered its disposers.
      dispose(anchor);
      return el;
    };

    createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/sd", name: "sd", component: async () => gate.promise },
      ],
      { keepAlive: 10 },
    );
    anchor = KeepAliveRoute();
    host.appendChild(anchor);
    await settle();

    await navigate("/sd");
    await settle();

    gate.resolve({ default: SelfDestruct });
    await settle();

    // The loader validates the factory once, so at least one instance exists.
    expect(created.length).toBeGreaterThan(0);
    // None of them may be left alive and unowned.
    expect(created.filter((id) => !disposed.includes(id))).toHaveLength(0);
    expect(host.querySelectorAll("[data-instance]")).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cache semantics must survive the ownership hardening
  // ─────────────────────────────────────────────────────────────────────────

  it("still reuses the cached instance across an A → B → A cycle", async () => {
    const createdA: string[] = [];
    const disposedA: string[] = [];
    const A = instrumented("a", createdA, disposedA);
    const createdB: string[] = [];
    const disposedB: string[] = [];
    const B = instrumented("b", createdB, disposedB);

    createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", name: "a", component: A },
        { path: "/b", name: "b", component: B },
      ],
      { keepAlive: 10 },
    );
    host.appendChild(KeepAliveRoute());
    await settle();

    await navigate("/a");
    await settle();
    const first = host.querySelector("[data-instance]");
    expect(first).not.toBeNull();
    const firstId = first?.getAttribute("data-instance");

    await navigate("/b");
    await settle();
    await navigate("/a");
    await settle();

    // Same DOM node, not a remount — that is the whole point of KeepAlive.
    const back = host.querySelector("[data-instance]");
    expect(back).toBe(first);
    expect(back?.getAttribute("data-instance")).toBe(firstId);

    // Exactly one A view exists; the cached one was reused, not duplicated.
    expect(host.querySelectorAll("[data-instance]")).toHaveLength(1);
    // A cached instance is never disposed while it is still cached.
    expect(disposedA).toHaveLength(0);
  });

  it("keeps the cache bounded by `max` under repeated distinct keys", async () => {
    const created: string[] = [];
    const disposed: string[] = [];
    const K = instrumented("k", created, disposed);

    createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/k", name: "k", component: K },
      ],
      { keepAlive: true },
    );
    host.appendChild(KeepAliveRoute({ max: 2 }));
    await settle();

    for (const p of ["1", "2", "3", "4", "5"]) {
      await navigate(`/k?p=${p}`);
      await settle();
    }

    // Only the live view is attached; evicted entries are disposed, not leaked.
    expect(host.querySelectorAll("[data-instance]")).toHaveLength(1);
    expect(disposed.length).toBeGreaterThan(0);
    // Cache holds at most `max` entries, so at most `max` instances stay alive.
    expect(created.filter((id) => !disposed.includes(id)).length).toBeLessThanOrEqual(3);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Deterministic multi-transition stress
  // ─────────────────────────────────────────────────────────────────────────

  it("settles on the newest valid generation across A B C A D B A", async () => {
    const created: string[] = [];
    const disposed: string[] = [];
    const gates = {
      a: deferred<{ default: () => HTMLElement }>(),
      b: deferred<{ default: () => HTMLElement }>(),
      c: deferred<{ default: () => HTMLElement }>(),
      d: deferred<{ default: () => HTMLElement }>(),
    };

    createRouter(
      [
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", name: "a", component: async () => gates.a.promise },
        { path: "/b", name: "b", component: async () => gates.b.promise },
        { path: "/c", name: "c", component: async () => gates.c.promise },
        { path: "/d", name: "d", component: async () => gates.d.promise },
      ],
      { keepAlive: 10 },
    );
    host.appendChild(KeepAliveRoute());
    await settle();

    observer = attachmentLog(host);

    // A and B resolve promptly and become cached views.
    await navigate("/a");
    gates.a.resolve({ default: instrumented("a", created, disposed) });
    await settle();
    await navigate("/b");
    gates.b.resolve({ default: instrumented("b", created, disposed) });
    await settle();

    // C is navigated to but left in flight, then superseded by a cached A.
    await navigate("/c");
    await settle();
    await navigate("/a");
    await settle();

    // D likewise: started, superseded by cached B, then cached A again.
    await navigate("/d");
    await settle();
    await navigate("/b");
    await settle();
    await navigate("/a");
    await settle();

    // Only now do the two abandoned loads complete, out of navigation order.
    gates.c.resolve({ default: instrumented("c", created, disposed) });
    await settle();
    gates.d.resolve({ default: instrumented("d", created, disposed) });
    await settle();

    // The final visible state is the newest valid generation: the cached /a.
    expect(window.location.pathname).toBe("/a");
    const visible = host.querySelectorAll("[data-instance]");
    expect(visible).toHaveLength(1);
    expect(visible[0]?.getAttribute("data-instance")).toMatch(/^a-/);

    // C and D lost their generations. Neither may appear in the DOM, and
    // neither may be left alive holding the effects it registered.
    expect(created.filter((id) => id.startsWith("c-") || id.startsWith("d-"))).toEqual(
      disposed.filter((id) => id.startsWith("c-") || id.startsWith("d-")),
    );

    // Every instance is disposed at most once — no double teardown.
    for (const id of created) {
      expect(disposed.filter((d) => d === id)).toHaveLength(1 - Number(!disposed.includes(id)));
    }

    // Exactly the two cached views (A and B) remain alive.
    expect(created.filter((id) => !disposed.includes(id))).toHaveLength(2);
  });
});
