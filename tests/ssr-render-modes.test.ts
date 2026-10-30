import { describe, expect, it, vi } from "vitest";
import { div } from "../src/core/rendering/html";
import { renderRoute } from "../src/platform/renderRoute";
import { Outlet, type RouteDef } from "../src/plugins/router";

const page = (text: string) => () => div(text);
const designer = vi.fn(page("designer"));

describe('route render: "ssr" | "prerender" | "client"', () => {
  const routes: RouteDef[] = [
    { path: "/", component: page("home") },
    { path: "/status", component: page("status"), render: "ssr" },
    { path: "/about", component: page("about"), render: "prerender" },
    {
      path: "/designer",
      component: designer,
      render: "client",
      head: { title: "Designer", description: "Draw your shirt" },
    },
    {
      path: "/admin",
      component: () => div([Outlet()]),
      render: "client",
      head: { robots: "noindex, nofollow" },
      children: [
        { path: "/orders", component: page("orders") },
        { path: "/public", component: page("public"), render: "prerender" },
      ],
    },
  ];

  it("renders a route that declares no mode (the default)", async () => {
    const r = await renderRoute(routes, "/");
    expect(r.render).toBe("default");
    expect(r.html).toContain("home");
  });

  it('renders "ssr" and "prerender" routes per request', async () => {
    expect((await renderRoute(routes, "/status")).html).toContain("status");
    expect((await renderRoute(routes, "/about")).html).toContain("about");
    expect((await renderRoute(routes, "/status")).render).toBe("ssr");
  });

  it('emits only the head for a "client" route and never runs its component', async () => {
    const r = await renderRoute(routes, "/designer");
    expect(r.render).toBe("client");
    expect(r.status).toBe(200);
    expect(r.html).toBe("");
    expect(r.head).toContain("<title>Designer</title>");
    expect(r.head).toContain('content="Draw your shirt"');
    expect(designer).not.toHaveBeenCalled();
  });

  it("inherits the mode from the deepest record that declares one", async () => {
    const orders = await renderRoute(routes, "/admin/orders");
    expect(orders.render).toBe("client");
    expect(orders.html).toBe("");
    expect(orders.noindex).toBe(true);
    const pub = await renderRoute(routes, "/admin/public");
    expect(pub.render).toBe("prerender");
    expect(pub.html).toContain("public");
  });
});
