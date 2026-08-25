/**
 * P1/P2 — Server/client route parity, and island isolation.
 *
 * Invariants under test:
 *  - Server and client route matching must agree for equivalent configurations.
 *  - Hydrating one island may not implicitly activate unrelated islands.
 *  - Island state may not cross between islands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { div } from "../src/core/rendering/html";
import { hydrateIslands, island, renderToString } from "../src/platform/ssr";
import { createRouter, destroyRouter, navigate, route, setRoutes } from "../src/plugins/router";
import { resolveServerRoute } from "../src/plugins/routerSSR";

const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

const el = (text: string) => () => {
  const d = document.createElement("div");
  d.textContent = text;
  return d;
};

describe("SSR/client route parity", () => {
  // One shared route table expressed for both routers.
  const PATHS = [
    { path: "/", name: "home" },
    { path: "/users", name: "users" },
    { path: "/users/new", name: "user-new" },
    { path: "/users/:id", name: "user-detail" },
    { path: "/search", name: "search" },
    { path: "/a/b/c", name: "deep" },
  ];

  const serverRoutes = PATHS.map((r) => ({ path: r.path, name: r.name, component: el(r.name) }));
  const clientRoutes = PATHS.map((r) => ({ path: r.path, name: r.name, component: el(r.name) }));

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes(clientRoutes);
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  const URLS = [
    "/",
    "/users",
    "/users/42",
    "/users/new",
    "/search?q=sibujs",
    "/a/b/c",
    "/users/hello%20world",
    "/users/%E2%9C%93",
  ];

  for (const url of URLS) {
    it(`server and client agree on "${url}"`, async () => {
      const server = resolveServerRoute(url, serverRoutes as never);

      await navigate(url);
      await settle();
      const client = route();

      expect(server.route.path).toBe(client.path);
      expect(server.route.params).toEqual(client.params);
      expect(server.route.query).toEqual(client.query);
    });
  }

  it("agrees that a static route outranks a dynamic one", async () => {
    // The classic divergence: server picks /users/new, client picks /users/:id.
    const server = resolveServerRoute("/users/new", serverRoutes as never);
    await navigate("/users/new");
    await settle();

    expect(server.route.path).toBe("/users/new");
    expect(server.route.params).toEqual({});
    expect(route().path).toBe("/users/new");
    expect(route().params).toEqual({});
  });

  it("agrees on an unmatched route", async () => {
    const server = resolveServerRoute("/definitely-not-a-route", serverRoutes as never);
    expect(server.component).toBeNull();

    await navigate("/definitely-not-a-route");
    await settle();
    // Both sides agree there is no match (client reports an empty matched set).
    expect(route().matched).toHaveLength(0);
  });

  it("agrees on decoded params for encoded URLs", async () => {
    const server = resolveServerRoute("/users/hello%20world", serverRoutes as never);
    await navigate("/users/hello%20world");
    await settle();

    expect(server.route.params.id).toBe("hello world");
    expect(route().params.id).toBe("hello world");
  });

  it("does not crash either side on a malformed percent sequence", async () => {
    expect(() => resolveServerRoute("/users/%E0%A4%A", serverRoutes as never)).not.toThrow();
    const result = await navigate("/users/%E0%A4%A");
    expect(typeof result.success).toBe("boolean");
  });

  it("agrees across a 1000-route table", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({
      path: `/r${i}`,
      name: `r${i}`,
      component: el(`r${i}`),
    }));

    destroyRouter();
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes(many);

    for (const i of [0, 1, 499, 998, 999]) {
      const server = resolveServerRoute(`/r${i}`, many as never);
      await navigate(`/r${i}`);
      await settle();

      expect(server.route.path).toBe(`/r${i}`);
      expect(route().path).toBe(`/r${i}`);
    }
  });
});

describe("islands: isolation", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  it("marks an island with a discoverable id", () => {
    const marked = island("counter", () => div("0") as HTMLElement);
    const html = renderToString(marked);

    expect(html).toContain("counter");
  });

  it("hydrates only the requested island, leaving others untouched", () => {
    const a = island("a", () => div({ id: "a-server" }, "A-server") as HTMLElement);
    const b = island("b", () => div({ id: "b-server" }, "B-server") as HTMLElement);
    host.append(a, b);

    const aFactory = vi.fn(() => div({ id: "a-client" }, "A-client") as HTMLElement);
    const bFactory = vi.fn(() => div({ id: "b-client" }, "B-client") as HTMLElement);

    // Hydrate only A.
    hydrateIslands(host, { a: aFactory });

    expect(aFactory).toHaveBeenCalledTimes(1);
    expect(bFactory).not.toHaveBeenCalled();
    // B's server markup must be completely untouched.
    expect(host.textContent).toContain("B-server");
  });

  it("keeps island state from crossing between islands", () => {
    const a = island("a", () => div("A-server") as HTMLElement);
    const b = island("b", () => div("B-server") as HTMLElement);
    host.append(a, b);

    hydrateIslands(host, {
      a: () => div({ id: "a-out" }, "state-1") as HTMLElement,
      b: () => div({ id: "b-out" }, "state-2") as HTMLElement,
    });

    expect(host.querySelector("#a-out")?.textContent).toBe("state-1");
    expect(host.querySelector("#b-out")?.textContent).toBe("state-2");
    expect(host.querySelector("#a-out")?.textContent).not.toContain("state-2");
  });

  it("keeps many islands independent", () => {
    const COUNT = 25;
    for (let i = 0; i < COUNT; i++) {
      host.appendChild(island(`i${i}`, () => div(`server-${i}`) as HTMLElement));
    }

    const registry: Record<string, () => HTMLElement> = {};
    for (let i = 0; i < COUNT; i++) {
      registry[`i${i}`] = () => div({ id: `out-${i}` }, `client-${i}`) as HTMLElement;
    }

    hydrateIslands(host, registry);

    for (let i = 0; i < COUNT; i++) {
      expect(host.querySelector(`#out-${i}`)?.textContent).toBe(`client-${i}`);
    }
  });

  it("hydrating a second island later does not re-run the first", () => {
    const a = island("a", () => div("A-server") as HTMLElement);
    const b = island("b", () => div("B-server") as HTMLElement);
    host.append(a, b);

    const aFactory = vi.fn(() => div({ id: "a-out" }, "A") as HTMLElement);
    const bFactory = vi.fn(() => div({ id: "b-out" }, "B") as HTMLElement);

    hydrateIslands(host, { a: aFactory });
    expect(aFactory).toHaveBeenCalledTimes(1);

    hydrateIslands(host, { b: bFactory });

    expect(bFactory).toHaveBeenCalledTimes(1);
    // A must not be hydrated a second time.
    expect(aFactory).toHaveBeenCalledTimes(1);
    expect(host.querySelector("#a-out")).not.toBeNull();
    expect(host.querySelector("#b-out")).not.toBeNull();
  });

  it("ignores an island id with no registered factory", () => {
    host.appendChild(island("known", () => div("server") as HTMLElement));

    expect(() => hydrateIslands(host, { unknown: () => div("never") as HTMLElement })).not.toThrow();
    // The unmatched island keeps its server markup.
    expect(host.textContent).toContain("server");
  });

  it("does not hydrate an island removed before activation", () => {
    const a = island("a", () => div("A-server") as HTMLElement);
    host.appendChild(a);

    const factory = vi.fn(() => div("A-client") as HTMLElement);

    // Container removed before hydration runs.
    host.replaceChildren();

    hydrateIslands(host, { a: factory });

    expect(factory).not.toHaveBeenCalled();
  });
});
