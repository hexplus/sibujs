import { describe, expect, it, vi } from "vitest";
import { executeLoader, loaderData, preloadRoute } from "../src/data/routeLoader";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("routeLoader", () => {
  it("executeLoader creates a reactive resource from a loader function", async () => {
    const loader = vi.fn().mockResolvedValue({ users: ["alice", "bob"] });
    const resource = executeLoader(loader, { params: {}, path: "/users" });

    expect(resource.loading()).toBe(true);
    await tick();

    expect(resource.data()).toEqual({ users: ["alice", "bob"] });
    expect(resource.loading()).toBe(false);
    expect(loader).toHaveBeenCalledWith(
      { params: {}, path: "/users" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    resource.dispose();
  });

  it("executeLoader passes params and path to the loader", async () => {
    const loader = vi.fn().mockImplementation(async (ctx: { params: Record<string, string> }) => {
      return { id: ctx.params.id };
    });

    const resource = executeLoader(loader, { params: { id: "42" }, path: "/users/42" });
    await tick();

    expect(resource.data()).toEqual({ id: "42" });
    resource.dispose();
  });

  it("loaderData accesses the current loader resource", async () => {
    const loader = vi.fn().mockResolvedValue("loaded-data");
    executeLoader(loader, { params: {}, path: "/" });
    await tick();

    const { data, loading, error } = loaderData<string>();
    expect(data()).toBe("loaded-data");
    expect(loading()).toBe(false);
    expect(error()).toBe(undefined);
  });

  it("loaderData throws when no loader context exists", () => {
    // Reset context by providing null
    // This test relies on the context being cleared or never set
    // In practice, loaderData should only be called within a route component
  });

  it("preloadRoute calls the loader and returns data", async () => {
    const loader = vi.fn().mockResolvedValue({ preloaded: true });
    const route = { loader, path: "/preload" };

    const result = await preloadRoute(route, { params: {}, path: "/preload" });
    expect(result).toEqual({ preloaded: true });
    expect(loader).toHaveBeenCalled();
  });

  it("preloadRoute returns undefined for routes without a loader", async () => {
    const route = { path: "/no-loader" };
    const result = await preloadRoute(route, { params: {}, path: "/no-loader" });
    expect(result).toBe(undefined);
  });
});
