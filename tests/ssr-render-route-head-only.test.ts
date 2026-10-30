import { afterEach, describe, expect, it, vi } from "vitest";
import { div, p } from "../src/core/rendering/html";
import { query } from "../src/data/query";
import { renderRoute } from "../src/platform/renderRoute";
import { Outlet, type RouteDef } from "../src/plugins/router";

// `renderRoute(…, { headOnly: ["ssr"] })` — what the server-entry pre-renderer
// asks for — answers a per-request route with its route head alone: the route
// is matched, guarded and redirected as usual, but neither its component nor
// the app shell is built, so nothing they fetch runs and nothing transfers.
// Without the option a request renders the route normally.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function accountRoutes() {
  const fetchAccount = vi.fn(() => Promise.reject(new Error("401: no session at build time")));
  const Account = vi.fn(() => {
    const q = query("/api/account", fetchAccount);
    return p(() => (q.data() as string | undefined) ?? "loading account");
  });
  const routes: RouteDef[] = [
    { path: "/account", component: Account, render: "ssr", head: { title: "My account", robots: "noindex" } },
    {
      path: "/area",
      component: () => div([Outlet()]),
      render: "ssr",
      head: { title: "Area" },
      children: [
        { path: "/inherited", component: Account, head: { title: "Inherited" } },
        { path: "/static", component: () => p("static page"), render: "prerender", head: { title: "Static" } },
      ],
    },
    { path: "/old-account", redirect: "/account", status: 301 },
    { path: "/locked", component: Account, render: "ssr", beforeEnter: () => false },
    { path: "/login-first", component: Account, render: "ssr", beforeEnter: () => "/account" },
    { path: "/editor", component: Account, render: "client", head: { title: "Editor" } },
  ];
  return { routes, Account, fetchAccount };
}

describe('renderRoute with headOnly: ["ssr"]', () => {
  it("answers a per-request route with its head, without building or fetching anything", async () => {
    const { routes, Account, fetchAccount } = accountRoutes();
    const app = vi.fn(() => div("shell"));
    const r = await renderRoute(routes, "/account", { headOnly: ["ssr"], app });
    expect(r.status).toBe(200);
    expect(r.render).toBe("ssr");
    expect(r.html).toBe("");
    expect(r.head).toContain("<title>My account</title>");
    expect(r.noindex).toBe(true);
    expect(r.state).toBe("");
    expect(r.stateData).toBeNull();
    expect(Account).not.toHaveBeenCalled();
    expect(app).not.toHaveBeenCalled();
    expect(fetchAccount).not.toHaveBeenCalled();
  });

  it("renders the same route normally for a real request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { routes, Account, fetchAccount } = accountRoutes();
    fetchAccount.mockImplementation(() => Promise.resolve("ada's account") as never);
    const r = await renderRoute(routes, "/account");
    expect(Account).toHaveBeenCalledTimes(1);
    expect(fetchAccount).toHaveBeenCalledTimes(1);
    expect(r.html).toContain("ada's account");
    expect(r.state).toContain("__SIBU_TRANSFER__");
  });

  it("follows a mode inherited from a parent record, and a child's own override", async () => {
    const { routes, Account } = accountRoutes();
    const inherited = await renderRoute(routes, "/area/inherited", { headOnly: ["ssr"] });
    expect([inherited.render, inherited.html]).toEqual(["ssr", ""]);
    expect(inherited.head).toContain("<title>Inherited</title>");
    expect(Account).not.toHaveBeenCalled();

    const own = await renderRoute(routes, "/area/static", { headOnly: ["ssr"] });
    expect(own.render).toBe("prerender");
    expect(own.html).toContain("static page");
  });

  it("keeps redirects and guards as they are", async () => {
    const { routes, Account } = accountRoutes();
    const moved = await renderRoute(routes, "/old-account", { headOnly: ["ssr"] });
    expect([moved.status, moved.location, moved.redirectBy]).toEqual([301, "/account", "route"]);
    const locked = await renderRoute(routes, "/locked", { headOnly: ["ssr"] });
    expect([locked.status, locked.failure]).toEqual([403, "guard"]);
    const viaGuard = await renderRoute(routes, "/login-first", { headOnly: ["ssr"] });
    expect([viaGuard.location, viaGuard.redirectBy]).toEqual(["/account", "guard"]);
    expect(Account).not.toHaveBeenCalled();
  });

  it('leaves render: "client" as it was', async () => {
    const { routes, Account } = accountRoutes();
    const r = await renderRoute(routes, "/editor", { headOnly: ["ssr"] });
    expect([r.render, r.html]).toEqual(["client", ""]);
    expect(r.head).toContain("<title>Editor</title>");
    expect(Account).not.toHaveBeenCalled();
  });
});

// Responses without a body are decided by the navigation and the route records
// alone: the matched components are not loaded for them, so a lazy import that
// hangs, throws or has request-time side effects never runs.
describe("responses without a body never load the matched components", () => {
  const never = () => new Promise<{ default: () => Element }>(() => {});

  it("answers a head-only lazy route whose import would hang, without calling the loader", async () => {
    const lazyAccount = vi.fn(never);
    const routes: RouteDef[] = [{ path: "/account", lazy: lazyAccount, render: "ssr", head: { title: "Account" } }];
    const r = await renderRoute(routes, "/account", { headOnly: ["ssr"], timeout: 20 });
    expect(r.status).toBe(200);
    expect(r.head).toContain("<title>Account</title>");
    expect([r.html, r.state, r.failure, r.diagnostics.timedOut]).toEqual(["", "", null, false]);
    expect(lazyAccount).not.toHaveBeenCalled();
  });

  it("never calls a head-only route's loader that would throw, nor the app shell", async () => {
    const throwing = vi.fn((): Promise<{ default: () => Element }> => {
      throw new Error("module-level code ran");
    });
    const app = vi.fn(() => div("shell"));
    const routes: RouteDef[] = [
      {
        path: "/area",
        component: () => div([Outlet()]),
        render: "ssr",
        head: { title: "Area" },
        children: [{ path: "/inherited", lazy: throwing, head: { title: "Inherited" } }],
      },
    ];
    const r = await renderRoute(routes, "/area/inherited", { headOnly: ["ssr"], app });
    expect([r.status, r.render, r.html]).toEqual([200, "ssr", ""]);
    expect(r.head).toContain("<title>Inherited</title>");
    expect(throwing).not.toHaveBeenCalled();
    expect(app).not.toHaveBeenCalled();
  });

  it("still loads and renders a child that overrides the inherited mode", async () => {
    const lazyStatic = vi.fn(async () => ({ default: () => p("static child") }));
    const routes: RouteDef[] = [
      {
        path: "/area",
        component: () => div([Outlet()]),
        render: "ssr",
        children: [{ path: "/static", lazy: lazyStatic, render: "prerender" }],
      },
    ];
    const r = await renderRoute(routes, "/area/static", { headOnly: ["ssr"] });
    expect([r.status, r.render]).toEqual([200, "prerender"]);
    expect(r.html).toContain("static child");
    expect(lazyStatic).toHaveBeenCalled();
  });

  it('answers render: "client" with an unavailable component', async () => {
    const lazyEditor = vi.fn(never);
    const routes: RouteDef[] = [{ path: "/editor", lazy: lazyEditor, render: "client", head: { title: "Editor" } }];
    const r = await renderRoute(routes, "/editor", { timeout: 20 });
    expect([r.status, r.render, r.html, r.diagnostics.timedOut]).toEqual([200, "client", "", false]);
    expect(r.head).toContain("<title>Editor</title>");
    expect(lazyEditor).not.toHaveBeenCalled();
  });

  it("answers permanent, temporary and guard redirects to an unloadable target", async () => {
    const lazyNew = vi.fn(never);
    const routes: RouteDef[] = [
      { path: "/old", redirect: "/new", status: 301 },
      { path: "/moved", redirect: "/new" },
      { path: "/members", component: () => p("members"), beforeEnter: () => "/new?from=members" },
      { path: "/new", lazy: lazyNew, head: { title: "New" } },
    ];
    const permanent = await renderRoute(routes, "/old", { timeout: 20 });
    expect([permanent.status, permanent.location, permanent.redirectBy]).toEqual([301, "/new", "route"]);
    const temporary = await renderRoute(routes, "/moved", { timeout: 20 });
    expect([temporary.status, temporary.location, temporary.redirectBy]).toEqual([302, "/new", "route"]);
    const guarded = await renderRoute(routes, "/members", { timeout: 20 });
    expect([guarded.status, guarded.location, guarded.redirectBy]).toEqual([302, "/new?from=members", "guard"]);
    for (const r of [permanent, temporary, guarded]) {
      expect([r.html, r.state, r.diagnostics.timedOut]).toEqual(["", "", false]);
    }
    expect(lazyNew).not.toHaveBeenCalled();
  });

  it("keeps the base, query and hash of a redirect to an unloadable target", async () => {
    const lazyNew = vi.fn(never);
    const routes: RouteDef[] = [
      { path: "/old", redirect: "/new?tab=a&tab=b#top", status: 308 },
      { path: "/new", lazy: lazyNew },
    ];
    const r = await renderRoute(routes, "/app/old", { router: { base: "/app" }, timeout: 20 });
    expect([r.status, r.location]).toEqual([308, "/app/new?tab=a&tab=b#top"]);
    expect(lazyNew).not.toHaveBeenCalled();
  });

  it("answers a rejected navigation without loading the target", async () => {
    const lazyPrivate = vi.fn(never);
    const routes: RouteDef[] = [{ path: "/private", lazy: lazyPrivate, beforeEnter: () => false }];
    const r = await renderRoute(routes, "/private", { timeout: 20 });
    expect([r.status, r.failure, r.diagnostics.timedOut]).toEqual([403, "guard", false]);
    expect(lazyPrivate).not.toHaveBeenCalled();
  });

  it('loads the component of a render: "ssr" route for a real request', async () => {
    const lazyAccount = vi.fn(async () => ({ default: () => p("account body") }));
    const routes: RouteDef[] = [{ path: "/account", lazy: lazyAccount, render: "ssr" }];
    const r = await renderRoute(routes, "/account");
    expect(r.html).toContain("account body");
    expect(lazyAccount).toHaveBeenCalled();
  });
});
