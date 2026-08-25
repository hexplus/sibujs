/**
 * Seeded model testing, hook lifecycle, base path, preload, and memory.
 *
 * The model suite maintains a reference state machine outside SibuJS and
 * compares the router against it after every operation. Randomness is seeded,
 * so any failure reports the seed and the complete operation sequence needed to
 * replay it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkLeaks } from "../src/core/rendering/dispose";
import {
  createRouter,
  destroyRouter,
  navigate,
  preloadRoute,
  Route,
  replace,
  route,
  afterEach as routerAfterEach,
  beforeEach as routerBeforeEach,
  setRoutes,
} from "../src/plugins/router";

/** Mulberry32 — deterministic PRNG so failures replay exactly. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

const el = (text: string) => () => {
  const d = document.createElement("div");
  d.textContent = text;
  return d;
};

describe("router hardening: seeded model testing", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  /**
   * Drive a random operation sequence and compare against a reference model
   * after every step.
   */
  async function model(seed: number, operations: number) {
    const rand = rng(seed);
    const randInt = (n: number) => Math.floor(rand() * n);

    const OPEN = ["/a", "/b", "/c"];
    const BLOCKED = "/blocked";
    const REDIRECTS: Record<string, string> = { "/old": "/a", "/legacy": "/b" };

    setRoutes([
      { path: "/", component: el("home") },
      ...OPEN.map((p) => ({ path: p, component: el(p) })),
      { path: BLOCKED, component: el("blocked"), beforeEnter: () => false },
      { path: "/old", redirect: "/a" },
      { path: "/legacy", redirect: "/b" },
    ]);

    // Reference model: the last successfully committed path.
    let expectedPath = route().path;
    const log: string[] = [];

    for (let step = 0; step < operations; step++) {
      const roll = randInt(10);
      let target: string;
      let isReplace = false;

      if (roll < 5) {
        target = OPEN[randInt(OPEN.length)];
      } else if (roll < 7) {
        target = OPEN[randInt(OPEN.length)];
        isReplace = true;
      } else if (roll < 8) {
        target = BLOCKED;
      } else {
        target = randInt(2) === 0 ? "/old" : "/legacy";
      }

      log.push(`${isReplace ? "replace" : "navigate"}("${target}")`);
      const result = isReplace ? await replace(target) : await navigate(target);
      await settle();

      // Update the model to match the documented semantics.
      if (target === BLOCKED) {
        // Guard denies: route must not change.
      } else if (target in REDIRECTS) {
        const dest = REDIRECTS[target];
        if (dest !== expectedPath) expectedPath = dest;
      } else if (target !== expectedPath) {
        expectedPath = target;
      }
      // An identical repeat is reported as duplicated and leaves state alone.

      const actualPath = route().path;
      if (actualPath !== expectedPath) {
        throw new Error(
          `Router diverged from model at step ${step} (seed ${seed}).\n` +
            `Operations: ${log.join(" -> ")}\n` +
            `Expected path: ${expectedPath}\n` +
            `Actual path:   ${actualPath}\n` +
            `Last result: ${JSON.stringify(result)}`,
        );
      }

      // location must always agree with committed route state.
      if (window.location.pathname !== expectedPath) {
        throw new Error(
          `location diverged from route at step ${step} (seed ${seed}).\n` +
            `Operations: ${log.join(" -> ")}\n` +
            `route(): ${actualPath}\nlocation: ${window.location.pathname}`,
        );
      }
    }
  }

  for (const seed of [123456, 987654, 42]) {
    it(`matches the reference model over 150 operations (seed ${seed})`, async () => {
      await model(seed, 150);
    });
  }

  it("settles on the last valid navigation after a rapid unawaited burst", async () => {
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/a", component: el("a") },
      { path: "/b", component: el("b") },
      { path: "/c", component: el("c") },
    ]);

    const rand = rng(2024);
    const targets = ["/a", "/b", "/c"];
    let last = "/a";

    // Fire 100 navigations without awaiting — only the final one may commit.
    const inflight: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      last = targets[Math.floor(rand() * targets.length)];
      inflight.push(navigate(last));
    }
    await Promise.allSettled(inflight);
    await settle();

    expect(route().path).toBe(last);
    expect(window.location.pathname).toBe(last);
  });
});

describe("router hardening: hook lifecycle", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/a", component: el("a") },
      { path: "/b", component: el("b") },
    ]);
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("stops calling a beforeEach hook after it is unregistered", async () => {
    const calls: string[] = [];
    const off = routerBeforeEach((to, _from, next) => {
      calls.push(to.path);
      next();
    });

    await navigate("/a");
    expect(calls).toContain("/a");

    off();
    calls.length = 0;

    await navigate("/b");
    expect(calls).toEqual([]);
  });

  it("stops calling an afterEach hook after it is unregistered", async () => {
    const calls: string[] = [];
    const off = routerAfterEach((to) => calls.push(to.path));

    await navigate("/a");
    expect(calls).toContain("/a");

    off();
    calls.length = 0;

    await navigate("/b");
    expect(calls).toEqual([]);
  });

  it("does not leak hooks across 1000 register/unregister cycles", async () => {
    const calls: string[] = [];

    for (let i = 0; i < 1000; i++) {
      const off = routerBeforeEach((_to, _from, next) => {
        calls.push("x");
        next();
      });
      off();
    }

    calls.length = 0;
    await navigate("/a");

    // Every hook was unregistered, so none may fire.
    expect(calls).toEqual([]);
  });

  it("a throwing afterEach hook does not fail the navigation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const off = routerAfterEach(() => {
      throw new Error("hook boom");
    });

    const result = await navigate("/a");

    expect(result.success).toBe(true);
    expect(route().path).toBe("/a");
    off();
  });
});

describe("router hardening: base path", () => {
  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("prefixes history entries with the configured base without duplicating it", async () => {
    window.history.replaceState({}, "", "/app/");
    createRouter({ mode: "history", base: "/app" });
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/users", component: el("users") },
    ]);

    await navigate("/users");

    expect(window.location.pathname).toBe("/app/users");
    // Route state is base-relative.
    expect(route().path).toBe("/users");
  });

  it("does not duplicate the base across repeated navigations", async () => {
    window.history.replaceState({}, "", "/app/");
    createRouter({ mode: "history", base: "/app" });
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/users", component: el("users") },
      { path: "/about", component: el("about") },
    ]);

    await navigate("/users");
    await navigate("/about");
    await navigate("/users");

    expect(window.location.pathname).toBe("/app/users");
    expect(window.location.pathname).not.toContain("/app/app");
  });

  it("keeps query and hash intact under a base path", async () => {
    window.history.replaceState({}, "", "/app/");
    createRouter({ mode: "history", base: "/app" });
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/users", component: el("users") },
    ]);

    await navigate("/users?tab=posts#bio");

    expect(window.location.pathname).toBe("/app/users");
    expect(route().query.tab).toBe("posts");
    expect(route().hash).toBe("bio");
  });
});

describe("router hardening: preload semantics", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("preload does not change the active route or history", async () => {
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/heavy", lazy: () => Promise.resolve({ default: el("heavy") }) },
    ]);

    const pathBefore = route().path;
    const lengthBefore = window.history.length;

    await preloadRoute("/heavy");
    await settle();

    expect(route().path).toBe(pathBefore);
    expect(window.history.length).toBe(lengthBefore);
    expect(window.location.pathname).toBe(pathBefore);
  });

  it("preload does not run afterEach hooks", async () => {
    const calls: string[] = [];
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/heavy", lazy: () => Promise.resolve({ default: el("heavy") }) },
    ]);

    const off = routerAfterEach((to) => calls.push(to.path));
    await preloadRoute("/heavy");
    await settle();
    off();

    expect(calls).not.toContain("/heavy");
  });

  it("a failed preload does not prevent a later navigation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    let attempt = 0;
    setRoutes([
      { path: "/", component: el("home") },
      {
        path: "/flaky",
        lazy: () => {
          attempt++;
          return attempt === 1 ? Promise.reject(new Error("chunk failed")) : Promise.resolve({ default: el("flaky") });
        },
      },
    ]);

    await preloadRoute("/flaky").catch(() => {});
    await settle();

    const result = await navigate("/flaky");
    expect(result.success).toBe(true);
    expect(route().path).toBe("/flaky");
  });
});

describe("router hardening: memory", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("keeps live bindings flat across 1000 route replacements", async () => {
    createRouter({ mode: "history", base: "" });
    setRoutes([
      { path: "/", component: el("home") },
      { path: "/a", component: el("a") },
      { path: "/b", component: el("b") },
    ]);

    const host = document.createElement("div");
    document.body.appendChild(host);
    host.appendChild(Route());

    try {
      // Warm up so first-run singletons are excluded.
      await navigate("/a");
      await settle();
      await navigate("/b");
      await settle();
      const baseline = checkLeaks();

      for (let i = 0; i < 1000; i++) {
        await navigate(i % 2 === 0 ? "/a" : "/b");
        await settle();
      }

      // Allow a small constant for the one mounted route.
      expect(checkLeaks()).toBeLessThanOrEqual(baseline + 2);
    } finally {
      host.remove();
    }
  });

  it("keeps live bindings flat across 200 create/destroy router cycles", async () => {
    createRouter({ mode: "history", base: "" });
    setRoutes([{ path: "/", component: el("home") }]);
    destroyRouter();
    const baseline = checkLeaks();

    for (let i = 0; i < 200; i++) {
      createRouter({ mode: "history", base: "" });
      setRoutes([
        { path: "/", component: el("home") },
        { path: "/a", component: el("a") },
      ]);
      await navigate("/a");
      await settle();
      destroyRouter();
    }

    expect(checkLeaks()).toBeLessThanOrEqual(baseline + 2);
  });

  it("keeps live bindings flat across repeated lazy-route cancellation", async () => {
    createRouter({ mode: "history", base: "" });

    const host = document.createElement("div");
    document.body.appendChild(host);
    host.appendChild(Route());

    try {
      setRoutes([
        { path: "/", component: el("home") },
        { path: "/slow", lazy: () => new Promise(() => {}) },
        { path: "/fast", component: el("fast") },
      ]);

      await navigate("/fast");
      await settle();
      const baseline = checkLeaks();

      // Each iteration abandons a lazy load that never resolves.
      for (let i = 0; i < 200; i++) {
        await navigate("/slow");
        await settle();
        await navigate("/fast");
        await settle();
      }

      expect(checkLeaks()).toBeLessThanOrEqual(baseline + 4);
    } finally {
      host.remove();
    }
  });
});
