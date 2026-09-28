/**
 * Route-instance scope: an outgoing route instance never observes the incoming
 * route.
 *
 * The router commits a navigation by writing its route state, and the outlet
 * swaps the component afterwards — a microtask later for a synchronous page, a
 * whole chunk download later for a lazy one. Every reactive computation owned
 * by the outgoing page used to subscribe to the router-global route, so in that
 * window it re-ran against the INCOMING route's params: `/user/1` → `/user/2`
 * made page 1's effects fetch user 2, and `/user/1` → `/settings` made them run
 * with `params.id === undefined`. Applications guarded every read.
 *
 * Invariant under test:
 *
 *   Once navigation from A to B commits, no reactive computation owned by route
 *   instance A observes B's params/query/hash as if they belonged to A.
 *
 * Each instance reads the route it was committed with. An outlet that KEEPS an
 * instance across a navigation (query/hash-only change, or a layout whose child
 * changed) forwards the new route to it; an instance being replaced keeps its
 * own route until it is disposed — including in its teardown.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { onMount, onUnmount } from "../src/core/rendering/lifecycle";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { __resetQueryCache, query } from "../src/data/query";
import {
  createRouter,
  destroyRouter,
  KeepAliveRoute,
  lazy,
  navigate,
  Outlet,
  Route,
  type RouteDef,
  route,
  router,
  routerState,
  Suspense,
} from "../src/plugins/router";

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Observation log. Every entry is `owner=>observed`: `owner` is what the
 * instance was created for, `observed` what a computation it owns read later.
 */
function observations() {
  const log: string[] = [];
  const sites: string[] = [];
  return {
    log,
    push: (owner: string, observed: unknown, site = "") => {
      log.push(`${owner}=>${String(observed)}`);
      sites.push(site);
    },
    /** Entries recorded by `owner` whose observation differs from `expected`, with the recording site. */
    foreign: (owner: string, expected: string) =>
      log
        .map((e, i) => [e, sites[i]] as const)
        .filter(([e]) => e.startsWith(`${owner}=>`) && e !== `${owner}=>${expected}`)
        .map(([e, site]) => (site ? `${e} @${site}` : e)),
  };
}

let host: HTMLDivElement;

async function start(routes: RouteDef[], initial: string, outlet: () => Node = Route) {
  window.history.replaceState({}, "", initial);
  createRouter(routes, { mode: "history" });
  host.appendChild(outlet());
  await settle();
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  try {
    destroyRouter();
  } catch {}
  host.remove();
  window.history.replaceState({}, "", "/");
});

/**
 * A page that observes `route().params[param]` from every kind of computation a
 * route instance owns: an effect, a derived read by a DOM binding, a
 * `routerState()` getter, an effect cleanup, an `onUnmount` teardown, a
 * `when()` branch rendered after setup, an effect created in `onMount`, and the
 * cleanup `onMount` returns.
 */
function observingPage(obs: ReturnType<typeof observations>, param: string, tick?: () => number) {
  return () => {
    const mine = String(route().params[param]);
    const el = document.createElement("div");
    el.dataset.page = mine;
    const state = routerState();
    const current = derived(() => route().params[param]);

    const stopEffect = effect((onCleanup) => {
      tick?.();
      obs.push(mine, route().params[param], "effect");
      obs.push(mine, state.params()[param], "routerState");
      obs.push(mine, router().currentRoute.params[param], "router()");
      onCleanup(() => obs.push(mine, route().params[param], "effect cleanup"));
    });
    registerDisposer(el, stopEffect);

    const label = document.createElement("span");
    const stopLabel = effect(() => {
      label.textContent = String(current());
      obs.push(mine, current(), "derived");
    });
    registerDisposer(el, stopLabel);
    el.appendChild(label);

    el.appendChild(
      when(
        () => true,
        () => {
          const branch = document.createElement("i");
          const stop = effect(() => {
            tick?.();
            obs.push(mine, route().params[param], "when branch");
          });
          registerDisposer(branch, stop);
          return branch;
        },
      ) as unknown as Node,
    );

    onMount(() => {
      const stop = effect(() => {
        tick?.();
        obs.push(mine, route().params[param], "onMount effect");
      });
      registerDisposer(el, stop);
      return () => obs.push(mine, route().params[param], "onMount cleanup");
    }, el);

    onUnmount(() => obs.push(mine, route().params[param], "onUnmount"), el);
    registerDisposer(el, () => obs.push(mine, route().params[param], "disposer"));
    return el;
  };
}

describe("route-instance scope: an outgoing instance never observes the incoming route", () => {
  it("/user/1 → /user/2: instance 1 only ever observes id 1, teardown included", async () => {
    const obs = observations();
    await start([{ path: "/user/:id", component: observingPage(obs, "id") }], "/user/1");
    expect(host.querySelector("[data-page]")?.getAttribute("data-page")).toBe("1");
    expect(obs.log.length).toBeGreaterThan(0);

    await navigate("/user/2");
    await settle();

    expect(obs.foreign("1", "1")).toEqual([]);
    expect(obs.foreign("2", "2")).toEqual([]);
    expect(host.querySelectorAll("[data-page]").length).toBe(1);
    expect(host.querySelector("[data-page]")?.getAttribute("data-page")).toBe("2");
    // The teardown observations did happen (cleanup + onUnmount).
    expect(obs.log.filter((e) => e === "1=>1").length).toBeGreaterThan(6);
  });

  it("a parent layout kept across a child-param change sees the new param; the outgoing child does not", async () => {
    const obs = observations();
    const layoutSeen: string[] = [];
    const Layout = () => {
      const el = document.createElement("section");
      registerDisposer(
        el,
        effect(() => {
          layoutSeen.push(String(route().params.id));
        }),
      );
      el.appendChild(Outlet());
      return el;
    };

    await start(
      [{ path: "/users", component: Layout, children: [{ path: "/:id", component: observingPage(obs, "id") }] }],
      "/users/1",
    );
    await navigate("/users/2");
    await settle();

    expect(layoutSeen).toEqual(["1", "2"]);
    expect(obs.foreign("1", "1")).toEqual([]);
    expect(obs.foreign("2", "2")).toEqual([]);
    expect(host.querySelector("[data-page]")?.getAttribute("data-page")).toBe("2");
  });

  it("a top-level route change never shows the outgoing page the next route's (missing) params", async () => {
    const obs = observations();
    await start(
      [
        { path: "/user/:id", component: observingPage(obs, "id") },
        { path: "/settings", component: () => document.createElement("form") },
      ],
      "/user/1",
    );
    await navigate("/settings");
    await settle();

    expect(obs.foreign("1", "1")).toEqual([]);
    expect(host.querySelector("[data-page]")).toBeNull();
    expect(host.querySelector("form")).not.toBeNull();
  });

  it("query-only navigation: a kept instance follows the query; a keyed (replaced) one does not", async () => {
    const kept: string[] = [];
    const Kept = () => {
      const el = document.createElement("div");
      registerDisposer(
        el,
        effect(() => {
          kept.push(String(route().query.q));
        }),
      );
      return el;
    };
    await start([{ path: "/search", component: Kept }], "/search?q=a");
    await navigate("/search?q=b");
    await settle();
    expect(kept).toEqual(["a", "b"]);
    destroyRouter();
    host.textContent = "";

    const obs = observations();
    const Keyed = () => {
      const mine = String(route().query.q);
      const el = document.createElement("div");
      registerDisposer(
        el,
        effect((onCleanup) => {
          obs.push(mine, route().query.q);
          onCleanup(() => obs.push(mine, route().query.q));
        }),
      );
      return el;
    };
    await start([{ path: "/search", component: Keyed, key: (r) => String(r.query.q) }], "/search?q=a");
    await navigate("/search?q=b");
    await settle();
    expect(obs.foreign("a", "a")).toEqual([]);
    expect(obs.log).toContain("b=>b");
  });

  it("hash-only navigation: a kept instance follows the hash; a keyed (replaced) one does not", async () => {
    const kept: string[] = [];
    const Kept = () => {
      const el = document.createElement("div");
      registerDisposer(
        el,
        effect(() => {
          kept.push(route().hash);
        }),
      );
      return el;
    };
    await start([{ path: "/docs", component: Kept }], "/docs#one");
    await navigate("/docs#two");
    await settle();
    expect(kept).toEqual(["one", "two"]);
    destroyRouter();
    host.textContent = "";

    const obs = observations();
    const Keyed = () => {
      const mine = route().hash;
      const el = document.createElement("div");
      registerDisposer(
        el,
        effect(() => {
          obs.push(mine, route().hash);
        }),
      );
      return el;
    };
    await start([{ path: "/docs", component: Keyed, key: (r) => r.hash }], "/docs#one");
    await navigate("/docs#two");
    await settle();
    expect(obs.foreign("one", "one")).toEqual([]);
    expect(obs.log).toContain("two=>two");
  });

  it("nested Outlet teardown: leaving the nested area never shows the child (or layout) the next route", async () => {
    const obs = observations();
    const layoutSeen: string[] = [];
    let childDisposed = 0;
    const Layout = () => {
      const el = document.createElement("section");
      registerDisposer(
        el,
        effect(() => {
          layoutSeen.push(route().path);
        }),
      );
      el.appendChild(Outlet());
      return el;
    };
    const Child = () => {
      const el = observingPage(obs, "id")();
      registerDisposer(el, () => childDisposed++);
      return el;
    };

    await start(
      [
        { path: "/users", component: Layout, children: [{ path: "/:id/posts", component: Child }] },
        { path: "/settings", component: () => document.createElement("form") },
      ],
      "/users/1/posts",
    );
    await navigate("/settings");
    await settle();

    expect(obs.foreign("1", "1")).toEqual([]);
    expect(layoutSeen).toEqual(["/users/1/posts"]);
    expect(childDisposed).toBe(1);
    expect(host.querySelector("section")).toBeNull();
  });

  it("lazy() route component: while the incoming chunk loads, the outgoing page stays live on its own route", async () => {
    const obs = observations();
    const [tick, setTick] = signal(0);
    const gate = deferred<{ default: () => HTMLElement }>();
    await start(
      [
        { path: "/user/:id", component: observingPage(obs, "id", tick) },
        { path: "/slow/:id", component: lazy(() => gate.promise) },
      ],
      "/user/1",
    );

    await navigate("/slow/9");
    await settle();
    // Still mounted while the chunk loads, and still reacting to its own state.
    expect(host.querySelector('[data-page="1"]')).not.toBeNull();
    const before = obs.log.length;
    setTick(1);
    expect(obs.log.length).toBeGreaterThan(before);

    gate.resolve({ default: () => document.createElement("article") });
    await settle();
    expect(host.querySelector("article")).not.toBeNull();
    expect(host.querySelector("[data-page]")).toBeNull();
    expect(obs.foreign("1", "1")).toEqual([]);
  });

  it("rapid A → B → A keeps instance A, which never observes B", async () => {
    const obs = observations();
    let created = 0;
    const gate = deferred<{ default: () => HTMLElement }>();
    const Page = observingPage(obs, "id");
    await start(
      [
        {
          path: "/user/:id",
          component: () => {
            created++;
            return Page();
          },
        },
        { path: "/slow", component: lazy(() => gate.promise) },
      ],
      "/user/1",
    );
    const first = host.querySelector('[data-page="1"]');

    await navigate("/slow");
    await navigate("/user/1");
    gate.resolve({ default: () => document.createElement("article") });
    await settle();

    expect(created).toBe(1);
    expect(host.querySelector('[data-page="1"]')).toBe(first);
    expect(host.querySelector("article")).toBeNull();
    expect(obs.foreign("1", "1")).toEqual([]);
  });

  it("KeepAlive: a cached view keeps observing only its own route while inactive, and is reused on return", async () => {
    const obs = observations();
    const created: string[] = [];
    const Page = observingPage(obs, "id");
    await start(
      [
        {
          path: "/user/:id",
          name: "user",
          component: () => {
            created.push(route().params.id);
            return Page();
          },
        },
      ],
      "/user/1",
      () => KeepAliveRoute({ max: 5 }),
    );
    const first = host.querySelector('[data-page="1"]');

    await navigate("/user/2");
    await settle();
    await navigate("/user/3");
    await settle();
    await navigate("/user/1");
    await settle();

    expect(created).toEqual(["1", "2", "3"]);
    expect(host.querySelector('[data-page="1"]')).toBe(first);
    for (const id of ["1", "2", "3"]) expect(obs.foreign(id, id)).toEqual([]);
  });

  it("Suspense inside a route: content resolving after setup is owned by (and scoped to) the instance", async () => {
    const obs = observations();
    const gate = deferred<HTMLElement>();
    const Page = () => {
      const mine = route().params.id;
      const el = document.createElement("div");
      el.dataset.page = mine;
      el.appendChild(
        Suspense({
          nodes: () => {
            const content = document.createElement("p");
            registerDisposer(
              content,
              effect(() => {
                obs.push(mine, route().params.id);
              }),
            );
            return mine === "1" ? gate.promise.then(() => content) : content;
          },
        }),
      );
      return el;
    };

    await start([{ path: "/user/:id", component: Page }], "/user/1");
    gate.resolve(document.createElement("span"));
    await settle();
    await navigate("/user/2");
    await settle();

    expect(obs.foreign("1", "1")).toEqual([]);
    expect(obs.log).toContain("1=>1");
    expect(obs.log).toContain("2=>2");
  });

  it("disposed instances stop reacting and leave no live computation behind", async () => {
    const runs = new Map<string, number>();
    const Page = () => {
      const mine = route().params.id;
      const el = document.createElement("div");
      el.dataset.page = mine;
      registerDisposer(
        el,
        effect(() => {
          route().params.id;
          routerState().query();
          runs.set(mine, (runs.get(mine) ?? 0) + 1);
        }),
      );
      return el;
    };
    await start([{ path: "/user/:id", component: Page }], "/user/1");
    await navigate("/user/2");
    await settle();
    await navigate("/user/3");
    await settle();
    const snapshot = new Map(runs);
    await navigate("/user/3?x=1");
    await settle();
    await navigate("/user/4");
    await settle();

    expect(runs.get("1")).toBe(snapshot.get("1"));
    expect(runs.get("2")).toBe(snapshot.get("2"));
    // The kept instance 3 followed the query-only change exactly once more.
    expect(runs.get("3")).toBe((snapshot.get("3") ?? 0) + 1);
    expect(host.querySelectorAll("[data-page]").length).toBe(1);
  });

  it("a computation that outlives its instance falls back to the router-global route", async () => {
    const holder: { shared: (() => string) | null } = { shared: null };
    const Page = () => {
      // A lazily-created, app-lifetime derived that happens to be created
      // while page 1 renders. It is not owned by the page.
      holder.shared ??= derived(() => String(route().params.id));
      return document.createElement("div");
    };
    await start([{ path: "/user/:id", component: Page }], "/user/1");
    expect(holder.shared?.()).toBe("1");
    await navigate("/user/2");
    await settle();
    expect(holder.shared?.()).toBe("2");
    await navigate("/user/3");
    await settle();
    expect(holder.shared?.()).toBe("3");
  });

  it("route() outside any route instance is the router-global route, immediately after navigate()", async () => {
    await start([{ path: "/user/:id", component: () => document.createElement("div") }], "/user/1");
    await navigate("/user/2");
    expect(route().params.id).toBe("2");
    expect(routerState().params().id).toBe("2");
  });

  it("a page's query keyed on route().params needs no guard: no foreign fetch while outgoing, no refetch on a query-only change", async () => {
    __resetQueryCache();
    const fetched: string[] = [];
    const gate = deferred<{ default: () => HTMLElement }>();
    const Page = () => {
      const el = document.createElement("div");
      const q = query(
        () => `lead:${route().params.id}`,
        async ({ key }) => {
          fetched.push(key);
          return key;
        },
      );
      registerDisposer(el, q.dispose);
      return el;
    };
    await start(
      [
        { path: "/leads/:id", component: Page },
        { path: "/settings", component: lazy(() => gate.promise) },
      ],
      "/leads/1",
    );
    expect(fetched).toEqual(["lead:1"]);

    await navigate("/leads/1?tab=notes");
    await settle();
    expect(fetched).toEqual(["lead:1"]);

    await navigate("/leads/2");
    await settle();
    expect(fetched).toEqual(["lead:1", "lead:2"]);

    // Leaving for a lazy page: the outgoing page's key never sees the next
    // route's (missing) id, even while the chunk loads.
    await navigate("/settings");
    await settle();
    gate.resolve({ default: () => document.createElement("form") });
    await settle();
    expect(fetched).toEqual(["lead:1", "lead:2"]);
    __resetQueryCache();
  });

  it("an instance disposed directly (outlet torn down) tears down on its own route", async () => {
    const obs = observations();
    await start([{ path: "/user/:id", component: observingPage(obs, "id") }], "/user/1");
    const outlet = host.firstChild as Node;
    dispose(outlet);
    await settle();
    expect(obs.foreign("1", "1")).toEqual([]);
    expect(host.querySelector("[data-page]")).toBeNull();
  });
});

describe("route-instance scope: onMount-returned cleanups", () => {
  /** A page whose onMount-returned cleanup records `owner=>observed`. */
  function cleanupPage(seen: string[], param = "id") {
    return () => {
      const mine = String(route().params[param]);
      const el = document.createElement("div");
      el.dataset.page = mine;
      onMount(() => {
        return () => seen.push(`${mine}=>${String(route().params[param])}`);
      }, el);
      return el;
    };
  }

  it("/user/1 → /user/2: page 1's onMount cleanup tears down on route 1", async () => {
    const seen: string[] = [];
    await start([{ path: "/user/:id", component: cleanupPage(seen) }], "/user/1");
    await navigate("/user/2");
    await settle();
    expect(seen).toEqual(["1=>1"]);
  });

  it("a top-level replacement: the cleanup never sees the next route's (missing) params", async () => {
    const seen: string[] = [];
    await start(
      [
        { path: "/user/:id", component: cleanupPage(seen) },
        { path: "/settings", component: () => document.createElement("form") },
      ],
      "/user/1",
    );
    await navigate("/settings");
    await settle();
    expect(seen).toEqual(["1=>1"]);
  });

  it("a nested child replacement: the child's cleanup keeps the child's route", async () => {
    const seen: string[] = [];
    const Layout = () => {
      const el = document.createElement("section");
      el.appendChild(Outlet());
      return el;
    };
    await start(
      [{ path: "/users", component: Layout, children: [{ path: "/:id", component: cleanupPage(seen) }] }],
      "/users/1",
    );
    await navigate("/users/2");
    await settle();
    await navigate("/users/3");
    await settle();
    expect(seen).toEqual(["1=>1", "2=>2"]);
  });

  it("KeepAlive eviction: an evicted view's cleanup runs on that view's own route", async () => {
    const seen: string[] = [];
    await start([{ path: "/user/:id", component: cleanupPage(seen) }], "/user/1", () => KeepAliveRoute({ max: 1 }));
    await navigate("/user/2");
    await settle();
    expect(seen).toEqual(["1=>1"]);
    await navigate("/user/3");
    await settle();
    expect(seen).toEqual(["1=>1", "2=>2"]);
  });

  it("KeepAlive: a view detached into the cache runs its cleanup on its own route", async () => {
    // Detaching is a native removal, seen by the unmount observer after the
    // navigation committed — the router is not disposing anything, so only
    // the cleanup's own pinned scope can give it route 1.
    const seen: string[] = [];
    await start([{ path: "/user/:id", component: cleanupPage(seen) }], "/user/1", () => KeepAliveRoute({ max: 5 }));
    await navigate("/user/2");
    await settle();
    expect(seen).toEqual(["1=>1"]);
  });

  it("teardown order: every owned cleanup reads the outgoing route, and the scope is released only afterwards", async () => {
    const seen: string[] = [];
    const holder: { outliving: (() => string) | null } = { outliving: null };
    const Page = () => {
      const mine = route().params.id;
      const record = (site: string) => seen.push(`${site}:${mine}=>${route().params.id}`);
      const el = document.createElement("div");
      const child = document.createElement("span");
      el.appendChild(child);
      holder.outliving ??= derived(() => String(route().params.id));
      registerDisposer(el, () => record("parent disposer"));
      registerDisposer(child, () => record("child disposer"));
      registerDisposer(
        el,
        effect((onCleanup) => {
          route().params.id;
          onCleanup(() => record("effect cleanup"));
        }),
      );
      onUnmount(() => record("onUnmount"), el);
      onMount(() => () => record("onMount cleanup"), el);
      return el;
    };
    await start([{ path: "/user/:id", component: Page }], "/user/1");
    expect(holder.outliving?.()).toBe("1");

    await navigate("/user/2");
    await settle();
    const page1 = seen.filter((e) => e.includes(":1=>"));
    expect(page1).toEqual(
      expect.arrayContaining([
        "child disposer:1=>1",
        "parent disposer:1=>1",
        "effect cleanup:1=>1",
        "onUnmount:1=>1",
        "onMount cleanup:1=>1",
      ]),
    );
    // Children tear down before their parent.
    expect(page1.indexOf("child disposer:1=>1")).toBeLessThan(page1.indexOf("parent disposer:1=>1"));
    expect(seen.some((e) => e.includes(":1=>2"))).toBe(false);

    // Released after teardown: the computation that outlived page 1 now
    // follows the router.
    expect(holder.outliving?.()).toBe("2");
  });
});

describe("route-instance scope: direct AsyncComponent vs lazy()", () => {
  /**
   * A direct AsyncComponent — an `async` factory, NOT `lazy()`. Only the part
   * before its first `await` runs inside the instance's route scope; the
   * continuation is the application's own async code, which SibuJS cannot
   * re-enter. These tests pin that documented limit.
   */
  function asyncPage(gates: Map<string, Promise<void>>, log: string[]) {
    return async () => {
      const mine = route().params.id;
      const el = document.createElement("div");
      el.dataset.page = mine;
      log.push(`before:${mine}=>${route().params.id}`);
      registerDisposer(
        el,
        effect(() => {
          log.push(`effect-before-await:${mine}=>${route().params.id}`);
        }),
      );
      await gates.get(mine);
      log.push(`after:${mine}=>${route().params.id}`);
      registerDisposer(
        el,
        effect(() => {
          log.push(`effect-after-await:${mine}=>${route().params.id}`);
        }),
      );
      return el;
    };
  }

  it("direct AsyncComponent: code before the first await is scoped; code after it reads the router-global route", async () => {
    const log: string[] = [];
    const gate1 = deferred<void>();
    const gates = new Map<string, Promise<void>>([
      ["1", gate1.promise],
      ["2", Promise.resolve()],
    ]);
    await start([{ path: "/user/:id", component: asyncPage(gates, log) }], "/user/1");
    expect(log).toContain("before:1=>1");

    // Navigate while page 1's continuation is still parked on its await.
    await navigate("/user/2");
    await settle();
    gate1.resolve();
    await settle();

    // Documented limit: the continuation runs after the router moved to
    // /user/2 and reads the router's route, not instance 1's.
    expect(log).toContain("after:1=>2");
    // Its superseded result never mounts; page 2 does.
    expect(host.querySelector('[data-page="1"]')).toBeNull();
    expect(host.querySelector('[data-page="2"]')).not.toBeNull();
  });

  it("direct AsyncComponent: an effect created before the await follows the instance; one created after it follows the router", async () => {
    const log: string[] = [];
    const gate2 = deferred<void>();
    const gates = new Map<string, Promise<void>>([
      ["1", Promise.resolve()],
      ["2", gate2.promise],
    ]);
    await start([{ path: "/user/:id", component: asyncPage(gates, log) }], "/user/1");
    expect(host.querySelector('[data-page="1"]')).not.toBeNull();

    // Page 1 stays mounted while page 2's async factory waits.
    await navigate("/user/2");
    await settle();
    expect(host.querySelector('[data-page="1"]')).not.toBeNull();

    expect(log.filter((e) => e.startsWith("effect-before-await:1=>"))).toEqual(["effect-before-await:1=>1"]);
    // Documented limit: the post-await effect is unscoped, so it observes the
    // incoming route while page 1 is still mounted.
    expect(log).toContain("effect-after-await:1=>2");

    gate2.resolve();
    await settle();
    expect(host.querySelector('[data-page="2"]')).not.toBeNull();
  });

  it("lazy(): the factory runs after module resolution inside the instance's scope", async () => {
    const log: string[] = [];
    const gate = deferred<void>();
    const Page = () => {
      const mine = route().params.id;
      const el = document.createElement("div");
      el.dataset.page = mine;
      registerDisposer(
        el,
        effect(() => {
          log.push(`${mine}=>${route().params.id}`);
        }),
      );
      return el;
    };
    await start(
      [
        { path: "/user/:id", component: lazy(() => gate.promise.then(() => ({ default: Page }))) },
        { path: "/settings", component: lazy(() => new Promise<never>(() => {})) },
      ],
      "/user/1",
    );
    gate.resolve();
    await settle();
    expect(host.querySelector('[data-page="1"]')).not.toBeNull();

    await navigate("/user/2");
    await settle();
    // Leave for a page whose chunk never arrives: page 2 stays mounted, on route 2.
    await navigate("/settings");
    await settle();

    expect(log).toEqual(["1=>1", "2=>2"]);
  });
});
