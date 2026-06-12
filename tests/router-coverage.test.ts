import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildURL, createRouter, destroyRouter, getRouteInfo, hasRoute, navigate, route } from "../src/plugins/router";

function comp(label: string) {
  return () => {
    const el = document.createElement("div");
    el.textContent = label;
    return el;
  };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  try {
    destroyRouter();
  } catch {}
  vi.restoreAllMocks();
});

describe("router redirect route definitions", () => {
  it("follows a static route-level redirect", async () => {
    createRouter([
      { path: "/", component: comp("home") },
      { path: "/old", redirect: "/new" },
      { path: "/new", component: comp("new") },
    ]);
    await navigate("/old");
    expect(route().path).toBe("/new");
  });

  it("follows a function redirect", async () => {
    createRouter([
      { path: "/", component: comp("home") },
      { path: "/go", redirect: () => "/dest" },
      { path: "/dest", component: comp("dest") },
    ]);
    await navigate("/go");
    expect(route().path).toBe("/dest");
  });
});

describe("router introspection helpers", () => {
  it("hasRoute / getRouteInfo report named routes", async () => {
    createRouter([
      { path: "/", component: comp("home"), name: "home" },
      { path: "/users/:id", component: comp("user"), name: "user" },
    ]);
    await navigate("/");

    expect(hasRoute("user")).toBe(true);
    expect(hasRoute("nope")).toBe(false);

    const info = getRouteInfo("user");
    expect(info?.path).toBe("/users/:id");
    expect(getRouteInfo("nope")).toBeNull();
  });

  it("buildURL composes paths, params, and query", async () => {
    createRouter([
      { path: "/", component: comp("home"), name: "home" },
      { path: "/users/:id", component: comp("user"), name: "user" },
    ]);
    await navigate("/");

    const byName = buildURL({ name: "user", params: { id: "42" }, query: { tab: "info" } });
    expect(byName).toContain("/users/42");
    expect(byName).toContain("tab=info");

    const byPath = buildURL({ path: "/users/7", query: { q: "x" } });
    expect(byPath).toContain("/users/7");
    expect(byPath).toContain("q=x");
  });
});
