/**
 * Route component **loading** vs **instantiation**.
 *
 * Contract under test:
 *  - Loading a route component definition and instantiating a route component
 *    are separate operations. Loading never runs user component code.
 *  - A component factory is invoked only when SibuJS intends to create a real
 *    instance — never merely to validate its return type.
 *  - A resolved `AsyncComponent` Element belongs to the route generation that
 *    requested it. It is never disposed before mount, and never cached as a
 *    reusable factory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDisposer } from "../src/core/rendering/dispose";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import {
  createRouter,
  destroyRouter,
  lazy,
  navigate,
  preloadRoute,
  Route,
  route,
  setRoutes,
} from "../src/plugins/router";

const settle = async (n = 30) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
};

describe("route component loading vs instantiation", () => {
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
      /* already torn down */
    }
    host.remove();
    vi.restoreAllMocks();
  });

  // LOAD-001
  describe("synchronous components", () => {
    it("invokes the factory exactly once on first mount", async () => {
      let calls = 0;
      const Page = () => {
        calls++;
        const d = document.createElement("div");
        d.dataset.page = "page";
        return d;
      };

      setRoutes([
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", component: Page },
      ]);
      host.appendChild(Route());

      await navigate("/a");
      await settle();

      // Proves a real mount happened — guards against a vacuous assertion.
      expect(host.querySelectorAll('[data-page="page"]').length).toBe(1);
      expect(calls).toBe(1);
    });

    // A side effect dispose() cannot undo: proves probe disposal could never
    // have made speculative invocation harmless.
    it("runs a non-DOM side effect exactly once on first mount", async () => {
      const events: string[] = [];
      const Page = () => {
        events.push("created");
        const d = document.createElement("div");
        d.dataset.page = "page";
        return d;
      };

      setRoutes([
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", component: Page },
      ]);
      host.appendChild(Route());

      await navigate("/a");
      await settle();

      expect(host.querySelectorAll('[data-page="page"]').length).toBe(1);
      expect(events).toEqual(["created"]);
    });

    it("invokes the factory once per real mount across a revisit", async () => {
      let calls = 0;
      const Page = () => {
        calls++;
        const d = document.createElement("div");
        d.dataset.page = "page";
        return d;
      };

      setRoutes([
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", component: Page },
        { path: "/b", component: () => document.createElement("div") },
      ]);
      host.appendChild(Route());

      await navigate("/a");
      await settle();
      const afterFirst = calls;

      await navigate("/b");
      await settle();
      await navigate("/a");
      await settle();

      expect(afterFirst).toBe(1);
      expect(calls).toBe(2);
      expect(host.querySelectorAll('[data-page="page"]').length).toBe(1);
    });
  });

  // LOAD-001
  describe("lazy module components", () => {
    it("imports the module once and instantiates once per mount", async () => {
      let imports = 0;
      let calls = 0;
      const Page = () => {
        calls++;
        const d = document.createElement("div");
        d.dataset.page = "lazy";
        return d;
      };

      setRoutes([
        { path: "/", component: () => document.createElement("div") },
        {
          path: "/a",
          component: async () => {
            imports++;
            return { default: Page };
          },
        },
        { path: "/b", component: () => document.createElement("div") },
      ]);
      host.appendChild(Route());

      await navigate("/a");
      await settle();

      expect(host.querySelectorAll('[data-page="lazy"]').length).toBe(1);
      expect(imports).toBe(1);
      expect(calls).toBe(1);

      await navigate("/b");
      await settle();
      await navigate("/a");
      await settle();

      // Module cached; the factory runs once per actual mount.
      expect(imports).toBe(1);
      expect(calls).toBe(2);
    });
  });

  // LOAD-003 — preload may load code, never run components.
  describe("preload purity", () => {
    const home = () => document.createElement("div");

    it("imports a lazy module without instantiating the component", async () => {
      let imports = 0;
      let calls = 0;
      const Page = () => {
        calls++;
        const d = document.createElement("div");
        d.dataset.page = "preloaded";
        return d;
      };

      setRoutes([
        { path: "/", component: home },
        {
          path: "/a",
          component: lazy(async () => {
            imports++;
            return { default: Page };
          }),
        },
      ]);
      host.appendChild(Route());
      await settle();

      await preloadRoute("/a");
      await settle();

      // The module resolved — that is the useful part of preloading…
      expect(imports).toBe(1);
      // …but the component factory was not called, so no DOM exists.
      expect(calls).toBe(0);
      expect(host.querySelectorAll('[data-page="preloaded"]').length).toBe(0);

      await navigate("/a");
      await settle();

      expect(calls).toBe(1);
      expect(host.querySelectorAll('[data-page="preloaded"]').length).toBe(1);
    });

    it("does not invoke a synchronous factory", async () => {
      let calls = 0;
      setRoutes([
        { path: "/", component: home },
        {
          path: "/a",
          component: () => {
            calls++;
            return document.createElement("div");
          },
        },
      ]);
      host.appendChild(Route());
      await settle();

      await preloadRoute("/a");
      await settle();

      expect(calls).toBe(0);
    });

    // The headline case: a directly supplied AsyncComponent has no separate
    // module to fetch, so there is nothing to preload without running it.
    it("does not invoke a direct AsyncComponent", async () => {
      let calls = 0;
      setRoutes([
        { path: "/", component: home },
        {
          path: "/a",
          component: async () => {
            calls++;
            return document.createElement("div");
          },
        },
      ]);
      host.appendChild(Route());
      await settle();

      await preloadRoute("/a");
      await settle();

      expect(calls).toBe(0);
    });

    it("does not invoke a plain Promise-returning factory", async () => {
      let calls = 0;
      const Page = () => {
        calls++;
        return Promise.resolve(document.createElement("div"));
      };
      setRoutes([
        { path: "/", component: home },
        { path: "/a", component: Page as never },
      ]);
      host.appendChild(Route());
      await settle();

      await preloadRoute("/a");
      await settle();

      expect(calls).toBe(0);
    });

    // Mandatory: a side effect `dispose()` cannot undo.
    it("runs no user side effect for a direct AsyncComponent", async () => {
      const effects: string[] = [];
      setRoutes([
        { path: "/", component: home },
        {
          path: "/a",
          component: async () => {
            effects.push("created");
            const d = document.createElement("div");
            d.dataset.page = "async";
            return d;
          },
        },
      ]);
      host.appendChild(Route());
      await settle();

      await preloadRoute("/a");
      await settle();
      expect(effects).toEqual([]);

      await navigate("/a");
      await settle();
      expect(effects).toEqual(["created"]);
      expect(host.querySelectorAll('[data-page="async"]').length).toBe(1);
    });

    it("creates no lifecycle resources for any route definition style", async () => {
      let calls = 0;
      let disposals = 0;
      const build = (name: string) => {
        calls++;
        const el = document.createElement("div");
        el.dataset.page = name;
        registerDisposer(el, () => {
          disposals++;
        });
        return el;
      };

      setRoutes([
        { path: "/", component: home },
        { path: "/sync", component: () => build("sync") },
        { path: "/async", component: async () => build("async") },
        { path: "/thenable", component: (() => Promise.resolve(build("thenable"))) as never },
        { path: "/lazy", component: lazy(async () => ({ default: () => build("lazy") })) },
      ]);
      host.appendChild(Route());
      await settle();

      for (const p of ["/sync", "/async", "/thenable", "/lazy"]) {
        await preloadRoute(p);
      }
      await settle();

      expect(calls).toBe(0);
      expect(disposals).toBe(0);
      expect(host.querySelectorAll("[data-page]").length).toBe(0);
    });

    it("stays a no-op when repeated", async () => {
      let imports = 0;
      let calls = 0;
      setRoutes([
        { path: "/", component: home },
        {
          path: "/a",
          component: lazy(async () => {
            imports++;
            return {
              default: () => {
                calls++;
                return document.createElement("div");
              },
            };
          }),
        },
        {
          path: "/direct",
          component: async () => {
            calls++;
            return document.createElement("div");
          },
        },
      ]);
      host.appendChild(Route());
      await settle();

      for (let i = 0; i < 3; i++) {
        await preloadRoute("/a");
        await preloadRoute("/direct");
      }
      await settle();

      // Module imported once and cached; no component ever instantiated.
      expect(imports).toBe(1);
      expect(calls).toBe(0);
    });

    it("keeps preload and a concurrent navigation to the same route consistent", async () => {
      let imports = 0;
      let calls = 0;
      setRoutes([
        { path: "/", component: home },
        {
          path: "/a",
          component: lazy(async () => {
            imports++;
            return {
              default: () => {
                calls++;
                const d = document.createElement("div");
                d.dataset.page = "raced";
                return d;
              },
            };
          }),
        },
      ]);
      host.appendChild(Route());
      await settle();

      // Navigation starts before the preload settles.
      await Promise.all([preloadRoute("/a"), navigate("/a")]);
      await settle();

      expect(imports).toBe(1);
      expect(calls).toBe(1);
      expect(host.querySelectorAll('[data-page="raced"]').length).toBe(1);
    });

    it("does not touch the current route when preloading a different one", async () => {
      let calls = 0;
      setRoutes([
        { path: "/", component: home },
        {
          path: "/other",
          component: () => {
            const d = document.createElement("div");
            d.dataset.page = "other";
            return d;
          },
        },
        {
          path: "/slow",
          component: lazy(async () => ({
            default: () => {
              calls++;
              return document.createElement("div");
            },
          })),
        },
      ]);
      host.appendChild(Route());
      await settle();

      const preloading = preloadRoute("/slow");
      await navigate("/other");
      await preloading;
      await settle();

      expect(calls).toBe(0);
      expect(host.querySelectorAll('[data-page="other"]').length).toBe(1);
    });

    it("does not discover component errors — those surface at navigation", async () => {
      let calls = 0;
      setRoutes([
        { path: "/", component: home },
        {
          path: "/bad",
          component: (async () => {
            calls++;
            return "not-an-element";
          }) as never,
        },
      ]);
      host.appendChild(Route());
      await settle();

      // The factory is never invoked, so preload cannot and does not fail.
      await expect(preloadRoute("/bad")).resolves.toBeUndefined();
      expect(calls).toBe(0);

      await navigate("/bad");
      await settle();

      expect(calls).toBe(1);
      expect(host.querySelector(".route-error")).not.toBe(null);
    });

    it("does not invoke an invalid synchronous factory during preload", async () => {
      let calls = 0;
      setRoutes([
        { path: "/", component: home },
        {
          path: "/bad",
          component: (() => {
            calls++;
            return "not-an-element";
          }) as never,
        },
      ]);
      host.appendChild(Route());
      await settle();

      await expect(preloadRoute("/bad")).resolves.toBeUndefined();
      expect(calls).toBe(0);

      await navigate("/bad");
      await settle();

      expect(calls).toBe(1);
      expect(host.querySelector(".route-error")).not.toBe(null);
    });

    it("surfaces a lazy module-load failure", async () => {
      setRoutes([
        { path: "/", component: home },
        {
          path: "/broken",
          component: lazy(async () => {
            throw new Error("module boom");
          }),
        },
      ]);
      host.appendChild(Route());
      await navigate("/");
      await settle();

      await expect(preloadRoute("/broken")).resolves.toBeUndefined();

      // A failed preload leaves the current route untouched.
      expect(route().path).toBe("/");
    });

    it("preloading then mounting invokes the factory once per real mount", async () => {
      let calls = 0;
      setRoutes([
        { path: "/", component: home },
        {
          path: "/a",
          component: async () => {
            calls++;
            const d = document.createElement("div");
            d.dataset.page = "async";
            return d;
          },
        },
        { path: "/b", component: home },
      ]);
      host.appendChild(Route());
      await settle();

      await preloadRoute("/a");
      await settle();
      expect(calls).toBe(0);

      await navigate("/a");
      await settle();
      expect(calls).toBe(1);

      await navigate("/b");
      await settle();
      await navigate("/a");
      await settle();
      expect(calls).toBe(2);
      expect(host.querySelectorAll('[data-page="async"]').length).toBe(1);
    });
  });

  it("does not instantiate any component when routes are registered", async () => {
    let calls = 0;
    const Page = () => {
      calls++;
      return document.createElement("div");
    };

    setRoutes([
      { path: "/", component: () => document.createElement("div") },
      { path: "/a", component: Page },
      { path: "/b", component: Page },
    ]);
    await settle();

    expect(calls).toBe(0);
  });

  // LOAD-002 — direct AsyncComponent: () => Promise<Element>
  describe("direct AsyncComponent", () => {
    /** An Element carrying observable lifecycle resources. */
    const makeLive = (name: string) => {
      const el = document.createElement("div");
      el.dataset.page = name;
      const [count, setCount] = signal(0);
      const state = { disposed: 0, effectRuns: 0, listenerCalls: 0 };

      const stop = effect(() => {
        count();
        state.effectRuns++;
      });
      const onClick = () => {
        state.listenerCalls++;
      };
      el.addEventListener("click", onClick);
      registerDisposer(el, () => {
        state.disposed++;
        stop();
        el.removeEventListener("click", onClick);
      });

      return {
        el,
        state,
        bump: () => setCount(count() + 1),
        click: () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })),
      };
    };

    it("does not dispose the resolved Element before mounting it", async () => {
      const live = makeLive("async");

      setRoutes([
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", component: async () => live.el },
      ]);
      host.appendChild(Route());

      await navigate("/a");
      await settle();

      // The Element the AsyncComponent resolved is mounted…
      expect(host.contains(live.el)).toBe(true);
      // …and it is still alive: never disposed on the way in.
      expect(live.state.disposed).toBe(0);
    });

    it("keeps a reactive binding live after mount", async () => {
      const live = makeLive("async");

      setRoutes([
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", component: async () => live.el },
      ]);
      host.appendChild(Route());

      await navigate("/a");
      await settle();
      expect(host.contains(live.el)).toBe(true);

      const runsBefore = live.state.effectRuns;
      live.bump();
      expect(live.state.effectRuns).toBeGreaterThan(runsBefore);

      live.click();
      expect(live.state.listenerCalls).toBe(1);
    });

    it("disposes the mounted Element exactly once when leaving the route", async () => {
      const live = makeLive("async");

      setRoutes([
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", component: async () => live.el },
        { path: "/b", component: () => document.createElement("div") },
      ]);
      host.appendChild(Route());

      await navigate("/a");
      await settle();
      expect(live.state.disposed).toBe(0);

      await navigate("/b");
      await settle();

      expect(host.contains(live.el)).toBe(false);
      expect(live.state.disposed).toBe(1);
    });

    // The router must not turn one resolved instance into a reusable factory.
    it("produces a fresh Element on revisit rather than reusing a disposed one", async () => {
      const produced: HTMLElement[] = [];
      let calls = 0;

      setRoutes([
        { path: "/", component: () => document.createElement("div") },
        {
          path: "/a",
          component: async () => {
            calls++;
            const el = document.createElement("div");
            el.dataset.page = "async";
            el.dataset.instance = String(calls);
            produced.push(el);
            return el;
          },
        },
        { path: "/b", component: () => document.createElement("div") },
      ]);
      host.appendChild(Route());

      await navigate("/a");
      await settle();
      const first = host.querySelector('[data-page="async"]');
      expect(first).not.toBe(null);

      await navigate("/b");
      await settle();
      await navigate("/a");
      await settle();

      const second = host.querySelector('[data-page="async"]');
      expect(second).not.toBe(null);
      // A second real instantiation happened, and it is not the disposed first.
      expect(calls).toBe(2);
      expect(second).not.toBe(first);
      expect(produced).toHaveLength(2);
    });

    it("supports a plain (non-async-declared) function returning a Promise", async () => {
      // RC-003 compatibility: not syntactically `async`, still an AsyncComponent.
      const Page = () => {
        const d = document.createElement("div");
        d.dataset.page = "thenable";
        return Promise.resolve(d);
      };

      setRoutes([
        { path: "/", component: () => document.createElement("div") },
        { path: "/a", component: Page as never },
      ]);
      host.appendChild(Route());

      await navigate("/a");
      await settle();

      expect(host.querySelectorAll('[data-page="thenable"]').length).toBe(1);
    });

    // LOAD-002 / ownership — must survive the loader rework.
    it("disposes a stale resolution exactly once and never mounts it", async () => {
      const live = makeLive("stale");
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });

      setRoutes([
        { path: "/", component: () => document.createElement("div") },
        {
          path: "/a",
          component: async () => {
            await gate;
            return live.el;
          },
        },
        { path: "/b", component: () => document.createElement("div") },
      ]);
      host.appendChild(Route());

      const pending = navigate("/a");
      await settle();

      // Supersede before the async component resolves.
      await navigate("/b");
      await settle();

      release();
      await pending.catch(() => {});
      await settle();

      expect(host.contains(live.el)).toBe(false);
      expect(live.state.disposed).toBe(1);

      const runsBefore = live.state.effectRuns;
      live.bump();
      expect(live.state.effectRuns).toBe(runsBefore);
      live.click();
      expect(live.state.listenerCalls).toBe(0);
    });
  });

  // Invalid return values are still rejected — just at real instantiation time.
  describe("invalid component results", () => {
    for (const [label, bad] of [
      ["a string", () => "nope" as never],
      ["null", () => null as never],
      ["a plain object", () => ({}) as never],
    ] as const) {
      it(`reports a controlled error when a component returns ${label}`, async () => {
        setRoutes([
          { path: "/", component: () => document.createElement("div") },
          { path: "/a", component: bad },
        ]);
        host.appendChild(Route());

        await navigate("/a");
        await settle();

        // No crash, nothing bogus committed.
        expect(host.querySelector(".route-error")).not.toBe(null);
      });
    }
  });
});
