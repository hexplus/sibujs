import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __removeRouterPagehideHandler,
  addRoute,
  back,
  beforeResolve,
  buildURL,
  createMemoryRouter,
  createRouter,
  destroyRouter,
  forward,
  getRouteInfo,
  getRouteTransition,
  go,
  hasRoute,
  KeepAliveRoute,
  lazy,
  navigate,
  Outlet,
  preloadRoute,
  push,
  Route,
  RouterLink,
  removeRoute,
  replace,
  route,
  router,
  afterEach as routerAfterEach,
  beforeEach as routerBeforeEach,
  routerPlugin,
  routerState,
  Suspense,
  setRoutes,
  setRouteTransition,
} from "../src/plugins/router";

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function makeComp(label: string) {
  return () => {
    const el = document.createElement("div");
    el.textContent = label;
    el.setAttribute("data-testid", label);
    return el;
  };
}

let containers: HTMLElement[] = [];
function mountContainer(): HTMLElement {
  const c = document.createElement("div");
  document.body.appendChild(c);
  containers.push(c);
  return c;
}

const originalError = console.error;
const originalWarn = console.warn;
const originalLog = console.log;

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  console.error = vi.fn();
  console.warn = vi.fn();
  console.log = vi.fn();
});

afterEach(() => {
  console.error = originalError;
  console.warn = originalWarn;
  console.log = originalLog;
  try {
    destroyRouter();
  } catch {}
  for (const c of containers) {
    if (c.parentNode) c.parentNode.removeChild(c);
  }
  containers = [];
});

// ===========================================================================
// RouteMatcher behavior (via navigate / route)
// ===========================================================================

describe("RouteMatcher", () => {
  it("matches a wildcard '*' route and exposes pathMatch", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "*", component: makeComp("NotFound") },
    ]);
    const r = await navigate("/totally/unknown/path");
    expect(r.success).toBe(true);
    expect(route().path).toBe("/totally/unknown/path");
    expect(route().params.pathMatch).toBe("/totally/unknown/path");
  });

  it("matches a prefixed wildcard '/files/*' route", async () => {
    createRouter([{ path: "/files/*", component: makeComp("Files") }]);
    await navigate("/files/docs/readme.md");
    expect(route().params.pathMatch).toBe("/docs/readme.md");
    // Exact base path also matches the wildcard
    const r2 = await navigate("/files");
    expect(r2.success).toBe(true);
    expect(route().params.pathMatch).toBe("");
  });

  it("does not match a prefixed wildcard for a sibling prefix", async () => {
    createRouter([
      { path: "/files/*", component: makeComp("Files") },
      { path: "/", component: makeComp("Home") },
    ]);
    const r = await navigate("/filesystem");
    // Should not match /files/* -> no match -> still navigates (no route)
    expect(r.success).toBe(true);
    expect(route().params.pathMatch).toBeUndefined();
  });

  it("matches optional segment routes both with and without the segment", async () => {
    createRouter([{ path: "/users/:id?", component: makeComp("Users") }]);
    await navigate("/users/42");
    expect(route().params.id).toBe("42");
    const r = await navigate("/users");
    expect(r.success).toBe(true);
    // optional missing -> id undefined
    expect(route().params.id).toBeUndefined();
  });

  it("falls back to raw segment on malformed percent decode", async () => {
    createRouter([{ path: "/p/:slug", component: makeComp("P") }]);
    await navigate("/p/%E0%A4%A");
    expect(route().params.slug).toBe("%E0%A4%A");
  });

  it("decodes valid percent-encoded params", async () => {
    createRouter([{ path: "/p/:slug", component: makeComp("P") }]);
    await navigate("/p/hello%20world");
    expect(route().params.slug).toBe("hello world");
  });

  it("escapes regex special characters in literal segments", async () => {
    createRouter([
      { path: "/a.b+c/:id", component: makeComp("Special") },
      { path: "/", component: makeComp("Home") },
    ]);
    await navigate("/a.b+c/9");
    expect(route().params.id).toBe("9");
    expect(route().path).toBe("/a.b+c/9");
  });

  it("parses query and hash from the full path", async () => {
    createRouter([{ path: "/s", component: makeComp("S") }]);
    await navigate("/s?q=test&n=2#frag");
    expect(route().query).toEqual({ q: "test", n: "2" });
    expect(route().hash).toBe("frag");
  });

  it("resolves named routes for navigation and findByName helpers", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/user/:id", name: "user", component: makeComp("User") },
    ]);
    await navigate({ name: "user", params: { id: "7" } });
    expect(route().path).toBe("/user/7");
    expect(hasRoute("user")).toBe(true);
    expect(hasRoute("nope")).toBe(false);
    expect(getRouteInfo("user")?.path).toBe("/user/:id");
    expect(getRouteInfo("missing")).toBeNull();
  });

  it("supports route aliases", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/about", alias: ["/info", "/about-us"], component: makeComp("About") },
    ]);
    const r1 = await navigate("/info");
    expect(r1.success).toBe(true);
    expect(route().path).toBe("/info");
    const r2 = await navigate("/about-us");
    expect(r2.success).toBe(true);
  });

  it("supports a single-string alias", async () => {
    createRouter([{ path: "/about", alias: "/info", component: makeComp("About") }]);
    const r = await navigate("/info");
    expect(r.success).toBe(true);
  });
});

// ===========================================================================
// Navigation guards
// ===========================================================================

describe("Navigation guards", () => {
  it("runs beforeEach, beforeResolve, and afterEach in order", async () => {
    const log: string[] = [];
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/dest", component: makeComp("Dest") },
    ]);
    await wait();
    const off1 = routerBeforeEach((_to, _from, next) => {
      log.push("beforeEach");
      next();
    });
    const off2 = beforeResolve((_to, _from, next) => {
      log.push("beforeResolve");
      next();
    });
    const off3 = routerAfterEach(() => {
      log.push("afterEach");
    });
    log.length = 0;
    await navigate("/dest");
    await wait();
    expect(log).toEqual(["beforeEach", "beforeResolve", "afterEach"]);
    off1();
    off2();
    off3();
  });

  it("beforeEach can redirect with a string", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/secret", component: makeComp("Secret") },
      { path: "/login", component: makeComp("Login") },
    ]);
    await wait();
    const off = routerBeforeEach((to, _from, next) => {
      if (to.path === "/secret") next("/login");
      else next();
    });
    await navigate("/secret");
    await wait();
    expect(route().path).toBe("/login");
    off();
  });

  it("beforeEach aborts navigation with next(false)", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/blocked", component: makeComp("Blocked") },
    ]);
    const off = routerBeforeEach((_to, _from, next) => {
      next(false);
    });
    const result = await navigate("/blocked");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.type).toBe("aborted");
    off();
  });

  it("beforeResolve can redirect with a string", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/a", component: makeComp("A") },
      { path: "/b", component: makeComp("B") },
    ]);
    await wait();
    const off = beforeResolve((to, _from, next) => {
      if (to.path === "/a") next("/b");
      else next();
    });
    await navigate("/a");
    await wait();
    expect(route().path).toBe("/b");
    off();
  });

  it("beforeResolve aborts navigation with next(false)", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/x", component: makeComp("X") },
    ]);
    const off = beforeResolve((_to, _from, next) => next(false));
    const result = await navigate("/x");
    expect(result.success).toBe(false);
    off();
  });

  it("guard error via next(Error) aborts navigation", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/err", component: makeComp("Err") },
    ]);
    const off = routerBeforeEach((_to, _from, next) => next(new Error("boom")));
    const result = await navigate("/err");
    expect(result.success).toBe(false);
    off();
  });

  it("guard that throws synchronously aborts navigation", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/throw", component: makeComp("Throw") },
    ]);
    const off = routerBeforeEach(() => {
      throw new Error("sync throw");
    });
    const result = await navigate("/throw");
    expect(result.success).toBe(false);
    off();
  });

  it("afterEach hook errors are caught and logged", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/go", component: makeComp("Go") },
    ]);
    const off = routerAfterEach(() => {
      throw new Error("afterEach boom");
    });
    const result = await navigate("/go");
    expect(result.success).toBe(true);
    expect(console.error).toHaveBeenCalled();
    off();
  });

  it("beforeEnter as a single guard returning string redirects", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/guarded", component: makeComp("Guarded"), beforeEnter: () => "/safe" },
      { path: "/safe", component: makeComp("Safe") },
    ]);
    await wait();
    await navigate("/guarded");
    await wait();
    expect(route().path).toBe("/safe");
  });

  it("beforeEnter returning false aborts", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/no", component: makeComp("No"), beforeEnter: () => false },
    ]);
    const result = await navigate("/no");
    expect(result.success).toBe(false);
  });

  it("guard timeout aborts navigation", async () => {
    createRouter(
      [
        { path: "/", component: makeComp("Home") },
        { path: "/slow", component: makeComp("Slow") },
      ],
      { guardTimeout: 20 },
    );
    const off = routerBeforeEach(() => {
      // never call next -> times out
    });
    const result = await navigate("/slow");
    expect(result.success).toBe(false);
    off();
  });

  it("redirect loops beyond MAX_REDIRECT_DEPTH abort", async () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    await wait();
    let count = 0;
    const off = routerBeforeEach((_to, _from, next) => {
      count++;
      next(`/loop${count}`);
    });
    const result = await navigate("/loop0");
    expect(result.success).toBe(false);
    off();
  });

  it("beforeEnter array: first guard passes, second aborts", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      {
        path: "/multi",
        component: makeComp("Multi"),
        beforeEnter: [() => true, () => false],
      },
    ]);
    await wait();
    const result = await navigate("/multi");
    expect(result.success).toBe(false);
  });

  it("beforeEnter array string redirect to unsafe target aborts", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      {
        path: "/ar",
        component: makeComp("Ar"),
        beforeEnter: [() => true, () => "javascript:bad()"],
      },
    ]);
    await wait();
    const result = await navigate("/ar");
    expect(result.success).toBe(false);
  });

  it("redirect via setTimeout async guard then succeeds", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/dr2", component: makeComp("Dr2") },
      { path: "/landing", component: makeComp("Landing") },
    ]);
    await wait();
    const off = routerBeforeEach((to, _from, next) => {
      if (to.path === "/dr2") {
        setTimeout(() => next("/landing"), 5);
      } else {
        next();
      }
    });
    await navigate("/dr2");
    await wait();
    expect(route().path).toBe("/landing");
    off();
  });
});

// ===========================================================================
// Redirect routes
// ===========================================================================

describe("Redirect routes", () => {
  it("follows a static redirect route", async () => {
    createRouter([
      { path: "/old", redirect: "/new" },
      { path: "/new", component: makeComp("New") },
    ]);
    await navigate("/old");
    await wait();
    expect(route().path).toBe("/new");
  });

  it("follows a function redirect route", async () => {
    createRouter([
      { path: "/u/:id", redirect: (to) => `/profile/${to.params.id}` },
      { path: "/profile/:id", component: makeComp("Profile") },
    ]);
    await navigate("/u/55");
    await wait();
    expect(route().path).toBe("/profile/55");
  });

  it("refuses absolute/protocol-relative redirects", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/evil", redirect: "https://evil.example.com" },
    ]);
    const result = await navigate("/evil");
    expect(result.success).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });

  it("refuses protocol-relative // redirects", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/evil2", redirect: "//evil.example.com" },
    ]);
    const result = await navigate("/evil2");
    expect(result.success).toBe(false);
  });

  it("refuses javascript: redirect targets", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/js", redirect: "javascript:alert(1)" },
    ]);
    const result = await navigate("/js");
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// Security: navigation target sanitization
// ===========================================================================

describe("Navigation target safety", () => {
  it("aborts navigation to javascript: targets", async () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const result = await navigate("javascript:alert(1)");
    expect(result.success).toBe(false);
  });

  it("aborts navigation to protocol-relative //host targets", async () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const result = await navigate("//evil.com/path");
    expect(result.success).toBe(false);
  });

  it("guard string redirect to dangerous target aborts", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/danger", component: makeComp("Danger") },
    ]);
    const off = routerBeforeEach((to, _from, next) => {
      if (to.path === "/danger") next("javascript:evil()");
      else next();
    });
    const result = await navigate("/danger");
    expect(result.success).toBe(false);
    off();
  });

  it("beforeResolve string redirect to dangerous target aborts", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/dr", component: makeComp("Dr") },
    ]);
    const off = beforeResolve((to, _from, next) => {
      if (to.path === "/dr") next("data:text/html,evil");
      else next();
    });
    const result = await navigate("/dr");
    expect(result.success).toBe(false);
    off();
  });

  it("beforeEnter string redirect to dangerous target aborts", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/be", component: makeComp("Be"), beforeEnter: () => "vbscript:msgbox" },
    ]);
    const result = await navigate("/be");
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// Duplicate navigation
// ===========================================================================

describe("Duplicate navigation detection", () => {
  it("detects duplicate by path/params/query/hash", async () => {
    createRouter([{ path: "/dup", component: makeComp("Dup") }]);
    await navigate("/dup?a=1#h");
    await wait();
    const result = await navigate("/dup?a=1#h");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.type).toBe("duplicated");
  });
});

// ===========================================================================
// resolvePath / buildURL
// ===========================================================================

describe("resolvePath / buildURL", () => {
  it("builds a URL from a string target", () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    expect(buildURL("/foo?x=1")).toBe("/foo?x=1");
  });

  it("builds a URL from named route + params + query + hash", () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/user/:id", name: "user", component: makeComp("User") },
    ]);
    const url = buildURL({ name: "user", params: { id: "9" }, query: { tab: "a" }, hash: "top" });
    expect(url).toBe("/user/9?tab=a#top");
  });

  it("encodes param values in resolvePath", () => {
    createRouter([{ path: "/s/:q", name: "s", component: makeComp("S") }]);
    const url = buildURL({ name: "s", params: { q: "a b/c" } });
    expect(url).toBe("/s/a%20b%2Fc");
  });
});

// ===========================================================================
// Programmatic navigation: push/replace/back/forward/go
// ===========================================================================

describe("Programmatic navigation", () => {
  it("push and replace navigate", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/p1", component: makeComp("P1") },
      { path: "/p2", component: makeComp("P2") },
    ]);
    await push("/p1");
    await wait();
    expect(route().path).toBe("/p1");
    await replace("/p2");
    await wait();
    expect(route().path).toBe("/p2");
  });

  it("back/forward/go call history without throwing", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/p1", component: makeComp("P1") },
    ]);
    await push("/p1");
    await wait();
    expect(() => back()).not.toThrow();
    expect(() => forward()).not.toThrow();
    expect(() => go(-1)).not.toThrow();
  });

  it("router() hook exposes the full API", async () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const rt = router();
    expect(typeof rt.push).toBe("function");
    expect(typeof rt.replace).toBe("function");
    expect(typeof rt.go).toBe("function");
    expect(typeof rt.back).toBe("function");
    expect(typeof rt.forward).toBe("function");
    expect(typeof rt.beforeEach).toBe("function");
    expect(typeof rt.beforeResolve).toBe("function");
    expect(typeof rt.afterEach).toBe("function");
    rt.go(0);
    rt.back();
    rt.forward();
  });

  it("uncreated router APIs throw", async () => {
    destroyRouter();
    expect(() => route()).toThrow();
    expect(() => navigate("/")).toThrow();
    expect(() => push("/")).toThrow();
    expect(() => replace("/")).toThrow();
    expect(() => go(1)).toThrow();
    expect(() => back()).toThrow();
    expect(() => forward()).toThrow();
    expect(() => router()).toThrow();
    expect(() => routerBeforeEach(() => {})).toThrow();
    expect(() => beforeResolve(() => {})).toThrow();
    expect(() => routerAfterEach(() => {})).toThrow();
    expect(() => setRoutes([])).toThrow();
    expect(() => routerState()).toThrow();
    expect(() => buildURL("/")).toThrow();
    expect(() => addRoute({ path: "/x", component: makeComp("X") })).toThrow();
    expect(() => removeRoute("/x")).toThrow();
    expect(() => KeepAliveRoute()).toThrow();
    await expect(preloadRoute("/")).rejects.toThrow();
    expect(hasRoute("x")).toBe(false);
    expect(getRouteInfo("x")).toBeNull();
    // recreate so afterEach cleanup is fine
    createRouter([{ path: "/", component: makeComp("Home") }]);
  });
});

// ===========================================================================
// Hash mode vs history mode
// ===========================================================================

describe("Hash mode", () => {
  it("reads the current path from the location hash", async () => {
    window.location.hash = "#/hashed";
    createRouter(
      [
        { path: "/", component: makeComp("Home") },
        { path: "/hashed", component: makeComp("Hashed") },
      ],
      { mode: "hash" },
    );
    await wait();
    expect(route().path).toBe("/hashed");
    window.location.hash = "";
  });

  it("createMemoryRouter uses hash mode and supports push", async () => {
    const mem = createMemoryRouter(
      [
        { path: "/", component: makeComp("Home") },
        { path: "/m", component: makeComp("M") },
      ],
      "/",
    );
    await wait();
    await mem.push("/m");
    await wait();
    expect(mem.currentPath()).toBe("/m");
  });
});

describe("History mode + base", () => {
  it("strips the base prefix from the pathname", async () => {
    window.history.replaceState({}, "", "/app/page");
    createRouter(
      [
        { path: "/", component: makeComp("Home") },
        { path: "/page", component: makeComp("Page") },
      ],
      { mode: "history", base: "/app" },
    );
    await wait();
    expect(route().path).toBe("/page");
  });
});

// ===========================================================================
// Scroll behavior
// ===========================================================================

describe("Scroll behavior", () => {
  it("invokes scrollBehavior and window.scrollTo via rAF", async () => {
    const scrollSpy = vi.fn();
    const origScrollTo = window.scrollTo;
    (window as any).scrollTo = scrollSpy;
    const origRaf = window.requestAnimationFrame;
    (window as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    };
    try {
      createRouter(
        [
          { path: "/", component: makeComp("Home") },
          { path: "/scrolled", component: makeComp("Scrolled") },
        ],
        {
          scrollBehavior: () => ({ x: 0, y: 250 }),
        },
      );
      await navigate("/scrolled");
      await wait();
      expect(scrollSpy).toHaveBeenCalledWith(0, 250);
    } finally {
      (window as any).scrollTo = origScrollTo;
      (window as any).requestAnimationFrame = origRaf;
    }
  });

  it("does not scroll when scrollBehavior returns null", async () => {
    const scrollSpy = vi.fn();
    const origScrollTo = window.scrollTo;
    (window as any).scrollTo = scrollSpy;
    try {
      createRouter(
        [
          { path: "/", component: makeComp("Home") },
          { path: "/ns", component: makeComp("Ns") },
        ],
        { scrollBehavior: () => null },
      );
      await navigate("/ns");
      await wait();
      expect(scrollSpy).not.toHaveBeenCalled();
    } finally {
      (window as any).scrollTo = origScrollTo;
    }
  });
});

// ===========================================================================
// Route meta + routerState
// ===========================================================================

describe("Route meta and routerState", () => {
  it("exposes meta on the route context", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/admin", component: makeComp("Admin"), meta: { requiresAuth: true, title: "Admin" } },
    ]);
    await navigate("/admin");
    await wait();
    expect(route().meta.requiresAuth).toBe(true);
    expect(route().meta.title).toBe("Admin");
  });

  it("routerState reflects current path/params/query/hash/meta/flags", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/u/:id", component: makeComp("U"), meta: { k: "v" } },
    ]);
    await navigate("/u/3?x=1#z");
    await wait();
    const st = routerState();
    expect(st.currentPath()).toBe("/u/3");
    expect(st.params()).toEqual({ id: "3" });
    expect(st.query()).toEqual({ x: "1" });
    expect(st.hash()).toBe("z");
    expect(st.meta()).toEqual({ k: "v" });
    expect(typeof st.isNavigating()).toBe("boolean");
    expect(typeof st.isReady()).toBe("boolean");
  });
});

// ===========================================================================
// Dynamic route management
// ===========================================================================

describe("Dynamic route management", () => {
  it("adds and removes routes at runtime", async () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    addRoute({ path: "/dyn", name: "dyn", component: makeComp("Dyn") });
    let r = await navigate("/dyn");
    expect(r.success).toBe(true);
    expect(route().path).toBe("/dyn");
    expect(hasRoute("dyn")).toBe(true);

    removeRoute("/dyn");
    r = await navigate("/dyn");
    // No longer matches; navigation succeeds but no params from route
    expect(hasRoute("dyn")).toBe(false);
  });

  it("adds a route with a parent path", async () => {
    createRouter([{ path: "/parent", component: makeComp("Parent") }]);
    addRoute({ path: "/child", component: makeComp("Child") }, "/parent");
    const r = await navigate("/parent/child");
    expect(r.success).toBe(true);
    expect(route().path).toBe("/parent/child");
  });

  it("adds a route with children", async () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    addRoute({
      path: "/p",
      component: makeComp("P"),
      children: [{ path: "/c", component: makeComp("C") }],
    });
    const r = await navigate("/p/c");
    expect(r.success).toBe(true);
  });
});

// ===========================================================================
// Component loader: lazy/async + error/retry cache
// ===========================================================================

describe("ComponentLoader", () => {
  it("loads a lazy component and caches it", async () => {
    const container = mountContainer();
    let _loadCount = 0;
    const loader = lazy(async () => {
      _loadCount++;
      return { default: makeComp("LazyPage") };
    });
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/lazy", component: loader },
    ]);
    container.appendChild(Route());
    await navigate("/lazy");
    await wait(150);
    expect(container.textContent).toContain("LazyPage");
  });

  it("shows an error node + retry when an async component rejects", async () => {
    const container = mountContainer();
    let attempts = 0;
    const failing = lazy(async () => {
      attempts++;
      if (attempts === 1) throw new Error("load failed");
      return { default: makeComp("Recovered") };
    });
    createRouter(
      [
        { path: "/", component: makeComp("Home") },
        { path: "/f", component: failing },
      ],
      { errorRetryDelay: 1 },
    );
    container.appendChild(Route());
    await navigate("/f");
    await wait(150);
    const errNode = container.querySelector(".route-error");
    expect(errNode).toBeTruthy();
    const retryBtn = container.querySelector(".route-error-retry") as HTMLButtonElement;
    expect(retryBtn).toBeTruthy();
    // Wait beyond the retry delay then click retry
    await wait(20);
    retryBtn.click();
    await wait(200);
    expect(container.textContent).toContain("Recovered");
  });

  it("blocks immediate reload while error cache is hot, then succeeds via Route after delay", async () => {
    const container = mountContainer();
    let attempts = 0;
    const failing = lazy(async () => {
      attempts++;
      if (attempts <= 2) throw new Error("always fails");
      return { default: makeComp("Healed") };
    });
    const r = createRouter(
      [
        { path: "/", component: makeComp("Home") },
        { path: "/ef", component: failing },
      ],
      { errorRetryDelay: 40 },
    );
    container.appendChild(Route());
    await navigate("/ef");
    await wait(120);
    // First load failed -> error node visible
    expect(container.querySelector(".route-error")).toBeTruthy();
    // Direct loadComponent while error cache is hot must reject quickly.
    await expect(r.loadComponent({ path: "/ef", component: failing }, "/ef")).rejects.toThrow();
  });

  it("preloadRoute warms the cache and swallows errors", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/pre", component: makeComp("Pre") },
    ]);
    await expect(preloadRoute("/pre")).resolves.toBeUndefined();
    // preload of a non-component route is a no-op
    await expect(preloadRoute("/nope")).resolves.toBeUndefined();
  });

  it("loadComponent throws for a route without a component (redirect)", async () => {
    const r = createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/r", redirect: "/" },
    ]);
    await expect(r.loadComponent({ path: "/r", redirect: "/" } as any, "/r")).rejects.toThrow(
      /does not have a component/,
    );
  });

  it("validates that a sync component returns an Element", async () => {
    const r = createRouter([{ path: "/", component: makeComp("Home") }]);
    const bad = (() => "not-an-element") as any;
    await expect(r.loadComponent({ path: "/bad", component: bad }, "/bad")).rejects.toThrow(/must return Element/);
  });

  it("wraps async component module that lacks a default Element", async () => {
    const r = createRouter([{ path: "/", component: makeComp("Home") }]);
    const badAsync = lazy(async () => ({ default: (() => "nope") as any }));
    await expect(r.loadComponent({ path: "/ba", component: badAsync }, "/ba")).rejects.toThrow();
  });

  it("extracts a component from an async loader returning a bare function", async () => {
    const r = createRouter([{ path: "/", component: makeComp("Home") }]);
    const asyncFn = (async () => makeComp("BareFn")) as any;
    const loaded = await r.loadComponent({ path: "/bf", component: asyncFn }, "/bf");
    expect(loaded()).toBeInstanceOf(Element);
  });

  it("extracts a component from an async loader returning an Element directly", async () => {
    const r = createRouter([{ path: "/", component: makeComp("Home") }]);
    const asyncEl = (async () => {
      const el = document.createElement("div");
      el.textContent = "DirectEl";
      return el;
    }) as any;
    const loaded = await r.loadComponent({ path: "/de", component: asyncEl }, "/de");
    expect(loaded()).toBeInstanceOf(Element);
  });

  it("serves a cached component on the second load", async () => {
    const r = createRouter([{ path: "/", component: makeComp("Home") }]);
    let calls = 0;
    const ld = lazy(async () => {
      calls++;
      return { default: makeComp("Cached") };
    });
    const c1 = await r.loadComponent({ path: "/c1", component: ld }, "/c1");
    const c2 = await r.loadComponent({ path: "/c1", component: ld }, "/c1");
    expect(c1).toBe(c2);
    expect(calls).toBe(1);
  });

  it("shares an in-flight loading promise for concurrent loads", async () => {
    const r = createRouter([{ path: "/", component: makeComp("Home") }]);
    let calls = 0;
    const ld = lazy(async () => {
      calls++;
      await wait(20);
      return { default: makeComp("Shared") };
    });
    const [a, b] = await Promise.all([
      r.loadComponent({ path: "/cc", component: ld }, "/cc"),
      r.loadComponent({ path: "/cc", component: ld }, "/cc"),
    ]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });
});

// ===========================================================================
// RouterLink
// ===========================================================================

describe("RouterLink", () => {
  it("renders an anchor with sanitized href and navigates on click", async () => {
    const container = mountContainer();
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/about", component: makeComp("About") },
    ]);
    container.appendChild(Route());
    const link = RouterLink({ to: "/about", nodes: "About" });
    container.appendChild(link);
    expect(link.getAttribute("href")).toBe("/about");
    link.click();
    await wait(100);
    expect(route().path).toBe("/about");
  });

  it("applies active and exact-active classes", async () => {
    const container = mountContainer();
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/about", component: makeComp("About") },
      { path: "/about/sub", component: makeComp("Sub") },
    ]);
    container.appendChild(Route());
    const link = RouterLink({ to: "/about", nodes: "About" });
    container.appendChild(link);
    await navigate("/about");
    await wait(80);
    expect(link.className).toContain("router-link-active");
    expect(link.className).toContain("router-link-exact-active");
    // Non-exact active when on a sub-path
    await navigate("/about/sub");
    await wait(80);
    expect(link.className).toContain("router-link-active");
    expect(link.className).not.toContain("router-link-exact-active");
  });

  it("honors custom activeClass / exactActiveClass props", async () => {
    const container = mountContainer();
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/x", component: makeComp("X") },
    ]);
    container.appendChild(Route());
    const link = RouterLink({ to: "/x", nodes: "X", activeClass: "on", exactActiveClass: "exact" });
    container.appendChild(link);
    await navigate("/x");
    await wait(80);
    expect(link.className).toContain("on");
    expect(link.className).toContain("exact");
  });

  it("sets target and adds noopener noreferrer for _blank", () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const link = RouterLink({ to: "/ext", nodes: "Ext", target: "_blank" });
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(link.rel).toContain("noreferrer");
  });

  it("merges provided rel with noopener for _blank", () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const link = RouterLink({ to: "/ext", nodes: "Ext", target: "_blank", rel: "author" });
    expect(link.rel).toContain("author");
    expect(link.rel).toContain("noopener");
  });

  it("sets rel for non-blank target", () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const link = RouterLink({ to: "/p", nodes: "P", target: "_self", rel: "nofollow" });
    expect(link.target).toBe("_self");
    expect(link.rel).toBe("nofollow");
  });

  it("sets rel without a target", () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const link = RouterLink({ to: "/p", nodes: "P", rel: "nofollow" });
    expect(link.rel).toBe("nofollow");
  });

  it("collapses unsafe javascript: targets to '#'", () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const link = RouterLink({ to: "javascript:alert(1)", nodes: "Bad" });
    expect(link.getAttribute("href")).toBe("#");
  });

  it("does not navigate on click when a target is set", async () => {
    const container = mountContainer();
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/t", component: makeComp("T") },
    ]);
    container.appendChild(Route());
    await navigate("/");
    await wait();
    const link = RouterLink({ to: "/t", nodes: "T", target: "_blank" });
    container.appendChild(link);
    link.click();
    await wait(60);
    expect(route().path).toBe("/");
  });

  it("does not navigate on click with a modifier key", async () => {
    const container = mountContainer();
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/m", component: makeComp("M") },
    ]);
    container.appendChild(Route());
    await navigate("/");
    await wait();
    const link = RouterLink({ to: "/m", nodes: "M" });
    container.appendChild(link);
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(ev);
    await wait(60);
    expect(route().path).toBe("/");
  });

  it("navigates with replace when replace prop set", async () => {
    const container = mountContainer();
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/rep", component: makeComp("Rep") },
    ]);
    container.appendChild(Route());
    const link = RouterLink({ to: "/rep", nodes: "Rep", replace: true });
    container.appendChild(link);
    link.click();
    await wait(80);
    expect(route().path).toBe("/rep");
  });

  it("sanitizes spread attributes: drops HREF override and on* handlers", () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const link = RouterLink({
      to: "/safe",
      nodes: "S",
      HREF: "javascript:evil()",
      ONCLICK: "evil()",
      onmouseover: "x()",
      "data-test": "ok",
    } as any);
    // HREF must not override the sanitized canonical href
    expect(link.getAttribute("href")).toBe("/safe");
    expect(link.getAttribute("onclick")).toBeNull();
    expect(link.getAttribute("onmouseover")).toBeNull();
    expect(link.getAttribute("data-test")).toBe("ok");
  });

  it("sanitizes url-bearing attributes and style", () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const link = RouterLink({
      to: "/safe",
      nodes: "S",
      src: "javascript:bad()",
      style: "color:red;background:url(javascript:bad())",
      title: "hi",
    } as any);
    // unsafe src dropped
    expect(link.getAttribute("src")).toBeNull();
    // style is sanitized (still set, but cleaned)
    expect(link.hasAttribute("style")).toBe(true);
    expect(link.getAttribute("title")).toBe("hi");
  });

  it("accepts number and boolean attribute values", () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const link = RouterLink({ to: "/n", nodes: "N", tabindex: 3, hidden: true } as any);
    expect(link.getAttribute("tabindex")).toBe("3");
    expect(link.getAttribute("hidden")).toBe("true");
  });

  it("accepts a Node child and an array of children", () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const span = document.createElement("span");
    span.textContent = "node-child";
    const link1 = RouterLink({ to: "/a", nodes: span });
    expect(link1.textContent).toContain("node-child");

    const span2 = document.createElement("span");
    span2.textContent = "B";
    const link2 = RouterLink({ to: "/b", nodes: ["A", span2] });
    expect(link2.textContent).toContain("A");
    expect(link2.textContent).toContain("B");
  });

  it("applies a base class via the class prop", () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const link = RouterLink({ to: "/c", nodes: "C", class: "btn" });
    expect(link.className).toContain("btn");
  });

  it("throws when router not initialized", () => {
    destroyRouter();
    expect(() => RouterLink({ to: "/", nodes: "X" })).toThrow();
    createRouter([{ path: "/", component: makeComp("Home") }]);
  });
});

// ===========================================================================
// KeepAliveRoute
// ===========================================================================

describe("KeepAliveRoute", () => {
  it("caches component nodes keyed by query string", async () => {
    const container = mountContainer();
    let renders = 0;
    const SearchComp = () => {
      renders++;
      const el = document.createElement("div");
      el.textContent = `render-${renders}`;
      return el;
    };
    createRouter(
      [
        { path: "/", component: makeComp("Home") },
        { path: "/search", name: "search", component: SearchComp },
      ],
      { keepAlive: 10 },
    );
    container.appendChild(KeepAliveRoute());
    await navigate("/search?q=a");
    await wait(120);
    const firstRenders = renders;
    expect(container.textContent).toContain("render-");
    // Different query -> new cache key -> new render
    await navigate("/search?q=b");
    await wait(120);
    expect(renders).toBeGreaterThan(firstRenders);
    // Back to first query -> served from cache, no new render
    const before = renders;
    await navigate("/search?q=a");
    await wait(120);
    expect(renders).toBe(before);
  });

  it("respects include filter (cache only named routes)", async () => {
    const container = mountContainer();
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/dash", name: "dash", component: makeComp("Dash") },
      { path: "/other", name: "other", component: makeComp("Other") },
    ]);
    container.appendChild(KeepAliveRoute({ include: ["dash"], max: 5 }));
    await navigate("/dash");
    await wait(120);
    expect(container.textContent).toContain("Dash");
    await navigate("/other");
    await wait(120);
    expect(container.textContent).toContain("Other");
  });

  it("evicts oldest entries beyond max", async () => {
    const container = mountContainer();
    createRouter(
      [
        { path: "/", component: makeComp("Home") },
        { path: "/k", name: "k", component: makeComp("K") },
      ],
      { keepAlive: true },
    );
    container.appendChild(KeepAliveRoute({ max: 1 }));
    await navigate("/k?p=1");
    await wait(100);
    await navigate("/k?p=2");
    await wait(100);
    await navigate("/k?p=3");
    await wait(100);
    expect(container.textContent).toContain("K");
  });

  it("follows redirects from within KeepAliveRoute", async () => {
    const container = mountContainer();
    createRouter(
      [
        { path: "/", component: makeComp("Home") },
        { path: "/redir", redirect: "/target" },
        { path: "/target", name: "target", component: makeComp("Target") },
      ],
      { keepAlive: true },
    );
    container.appendChild(KeepAliveRoute());
    await navigate("/target");
    await wait(120);
    expect(container.textContent).toContain("Target");
  });
});

// ===========================================================================
// Outlet (nested)
// ===========================================================================

describe("Outlet", () => {
  it("renders the deepest matched child", async () => {
    const container = mountContainer();
    const Layout = () => {
      const wrap = document.createElement("div");
      wrap.textContent = "Layout:";
      wrap.appendChild(Outlet());
      return wrap;
    };
    createRouter([
      {
        path: "/dash",
        component: Layout,
        children: [{ path: "/stats", component: makeComp("Stats") }],
      },
    ]);
    container.appendChild(Route());
    await navigate("/dash/stats");
    await wait(150);
    expect(container.textContent).toContain("Layout:");
    expect(container.textContent).toContain("Stats");
  });
});

// ===========================================================================
// Suspense
// ===========================================================================

describe("Suspense", () => {
  it("renders async content after the fallback", async () => {
    const container = mountContainer();
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const node = Suspense({
      fallback: () => {
        const f = document.createElement("div");
        f.textContent = "Loading";
        return f;
      },
      nodes: async () => {
        await wait(20);
        const el = document.createElement("div");
        el.textContent = "Loaded";
        return el;
      },
    });
    container.appendChild(node);
    await wait(120);
    expect(container.textContent).toContain("Loaded");
  });

  it("renders sync content directly", async () => {
    const container = mountContainer();
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const node = Suspense({
      nodes: () => {
        const el = document.createElement("div");
        el.textContent = "SyncContent";
        return el;
      },
    });
    container.appendChild(node);
    await wait(60);
    expect(container.textContent).toContain("SyncContent");
  });

  it("shows an error element when nodes() throws", async () => {
    const container = mountContainer();
    createRouter([{ path: "/", component: makeComp("Home") }]);
    const node = Suspense({
      fallback: () => {
        const f = document.createElement("div");
        f.textContent = "Loading";
        return f;
      },
      nodes: async () => {
        throw new Error("suspense fail");
      },
    });
    container.appendChild(node);
    await wait(120);
    const errEl = container.querySelector(".suspense-error");
    expect(errEl).toBeTruthy();
    expect(errEl?.textContent).toContain("suspense fail");
  });
});

// ===========================================================================
// Router plugins
// ===========================================================================

describe("routerPlugin", () => {
  it("invokes onReady and onNavigate", async () => {
    createRouter([
      { path: "/", component: makeComp("Home") },
      { path: "/np", component: makeComp("Np") },
    ]);
    await wait(20);
    const navs: string[] = [];
    let ready = false;
    const off = routerPlugin({
      name: "test-plugin",
      onReady: () => {
        ready = true;
      },
      onNavigate: (to) => {
        navs.push(to.path);
      },
    });
    await navigate("/np");
    await wait();
    expect(ready).toBe(true);
    expect(navs).toContain("/np");
    off();
    // After removal no more navigations recorded
    const before = navs.length;
    await navigate("/");
    await wait();
    expect(navs.length).toBe(before);
  });
});

// ===========================================================================
// Route transitions
// ===========================================================================

describe("Route transitions", () => {
  it("set/get round-trips the transition options", () => {
    expect(getRouteTransition()).toBeTypeOf("object");
    setRouteTransition({ enterClass: "fade-in", leaveClass: "fade-out", duration: 200 });
    expect(getRouteTransition()).toEqual({ enterClass: "fade-in", leaveClass: "fade-out", duration: 200 });
  });
});

// ===========================================================================
// updateRoutes / setRoutes
// ===========================================================================

describe("updateRoutes / setRoutes", () => {
  it("replaces routes via setRoutes", async () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    setRoutes([
      { path: "/", component: makeComp("Home") },
      { path: "/fresh", component: makeComp("Fresh") },
    ]);
    const r = await navigate("/fresh");
    expect(r.success).toBe(true);
    expect(route().path).toBe("/fresh");
  });
});

// ===========================================================================
// pagehide handler
// ===========================================================================

describe("pagehide handler", () => {
  it("destroys the router when the page is discarded (persisted=false)", async () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    await wait();
    const ev = new Event("pagehide") as PageTransitionEvent;
    Object.defineProperty(ev, "persisted", { value: false });
    window.dispatchEvent(ev);
    // After discard the global router should be gone
    expect(() => route()).toThrow();
    __removeRouterPagehideHandler();
    createRouter([{ path: "/", component: makeComp("Home") }]);
  });

  it("keeps the router alive when persisted=true (bfcache)", async () => {
    createRouter([{ path: "/", component: makeComp("Home") }]);
    await wait();
    const ev = new Event("pagehide") as PageTransitionEvent;
    Object.defineProperty(ev, "persisted", { value: true });
    window.dispatchEvent(ev);
    expect(() => route()).not.toThrow();
    __removeRouterPagehideHandler();
  });
});
