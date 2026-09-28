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
 * `when()` branch rendered after setup, and an effect created in `onMount`.
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
      return undefined;
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

  it("async route component: while the incoming chunk loads, the outgoing page stays live on its own route", async () => {
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
