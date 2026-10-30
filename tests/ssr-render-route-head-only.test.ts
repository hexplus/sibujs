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
