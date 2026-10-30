import { afterEach, describe, expect, it } from "vitest";
import { p } from "../src/core/rendering/html";
import { trackPending } from "../src/core/ssr-context";
import { createRenderHandler } from "../src/platform/renderHandler";
import { renderRoute } from "../src/platform/renderRoute";
import { destroyRouter, navigate, type RouteDef, route } from "../src/plugins/router";

// The URL contract under a router `base`: `renderRoute(routes, url)` and a
// memory router's `url` take the REQUEST URL — the base is stripped once, at a
// segment boundary — while navigation targets and route paths are
// application paths. Redirects put the base back exactly once.

afterEach(() => {
  destroyRouter();
});

const routes: RouteDef[] = [
  { path: "/", component: () => p("home") },
  { path: "/about", component: () => p(() => `about ${JSON.stringify(route().queryAll)} #${route().hash}`) },
  { path: "/old", redirect: "/about" },
  { path: "*", component: () => p("not found"), status: 404 },
];
const base = { router: { base: "/app" } };

describe("renderRoute under a router base", () => {
  it("renders /app/about as the /about route", async () => {
    const r = await renderRoute(routes, "/app/about", base);
    expect(r.status).toBe(200);
    expect(r.route?.path).toBe("/about");
    expect(r.html).toContain("about");
  });

  it("is reached the same way through createRenderHandler", async () => {
    const handle = createRenderHandler(routes, base);
    const res = await handle(new Request("http://x.test/app/about"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("about {}");
  });

  it("maps the base itself, with or without a trailing slash, to /", async () => {
    for (const url of ["/app", "/app/", "/app?x=1"]) {
      const r = await renderRoute(routes, url, base);
      expect([url, r.status, r.route?.path]).toEqual([url, 200, "/"]);
    }
  });

  it("keeps the query (repeated keys included) and the hash", async () => {
    const r = await renderRoute(routes, "/app/about?tag=a&tag=b&q=1#top", base);
    expect(r.route?.path).toBe("/about");
    expect(r.route?.query).toEqual({ tag: "b", q: "1" });
    expect(r.route?.hash).toBe("top");
    expect(r.html).toContain('about {"tag":["a","b"],"q":["1"]} #top');
  });

  it("does not treat a longer segment sharing the prefix as being under the base", async () => {
    const r = await renderRoute(routes, "/application/about", base);
    expect(r.status).toBe(404);
    expect(r.route?.path).toBe("/application/about");
  });

  it("puts the base in a redirect's Location exactly once", async () => {
    const r = await renderRoute(routes, "/app/old", base);
    expect(r.status).toBe(302);
    expect(r.location).toBe("/app/about");
  });

  it("navigates programmatically with application paths", async () => {
    const appRoutes: RouteDef[] = [
      {
        path: "/start",
        component: () => {
          trackPending(navigate("/about?from=start"), "test:navigate");
          return p("start");
        },
      },
      ...routes,
    ];
    const r = await renderRoute(appRoutes, "/app/start", base);
    expect(r.route?.path).toBe("/start");
    expect(r.html).toContain("about");
    expect(r.html).toContain('"from":["start"]');
  });

  it("is unchanged without a base, and with the trailingSlash policy", async () => {
    expect((await renderRoute(routes, "/about")).status).toBe(200);
    expect((await renderRoute(routes, "/app/about")).status).toBe(404);
    expect(
      (await renderRoute(routes, "/app/about/", { router: { base: "/app", trailingSlash: "ignore" } })).status,
    ).toBe(200);
    expect((await renderRoute(routes, "/app/about/", base)).status).toBe(404);
  });
});
