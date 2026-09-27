import { describe, expect, it, vi } from "vitest";
import { buildRouteEntries, fileToRoute, sibuRouteSplitting } from "../src/build/routeSplitting";

describe("fileToRoute", () => {
  it("maps index.ts to /", () => {
    expect(fileToRoute("index.ts")).toBe("/");
  });

  it("maps a nested index to its directory route", () => {
    expect(fileToRoute("users/index.ts")).toBe("/users");
  });

  it("maps a plain file to a simple route", () => {
    expect(fileToRoute("about.ts")).toBe("/about");
  });

  it("converts [param] segments to :param", () => {
    expect(fileToRoute("users/[id].ts")).toBe("/users/:id");
  });

  it("converts catch-all [...slug] to *", () => {
    expect(fileToRoute("blog/[...slug].ts")).toBe("/blog/*");
  });

  it("skips files prefixed with underscore (layout/middleware)", () => {
    expect(fileToRoute("_layout.ts")).toBeNull();
    expect(fileToRoute("_middleware.ts")).toBeNull();
    expect(fileToRoute("users/_layout.ts")).toBeNull();
  });

  it("handles tsx/jsx/js extensions", () => {
    expect(fileToRoute("about.tsx")).toBe("/about");
    expect(fileToRoute("about.jsx")).toBe("/about");
    expect(fileToRoute("about.js")).toBe("/about");
  });
});

describe("buildRouteEntries", () => {
  it("builds entries with chunk names and dynamic flags", () => {
    const entries = buildRouteEntries(["index.ts", "users/[id].ts"], "route-");
    const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
    expect(byPath["/"].isDynamic).toBe(false);
    expect(byPath["/users/:id"].isDynamic).toBe(true);
    expect(byPath["/users/:id"].importPath).toBe("users/[id].ts");
    expect(byPath["/users/:id"].chunkName.startsWith("route-")).toBe(true);
    // chunk name should be sanitized (no brackets/slashes/dots)
    expect(byPath["/users/:id"].chunkName).not.toMatch(/[/\\[\].]/);
  });

  it("skips files that map to null (underscore-prefixed)", () => {
    const entries = buildRouteEntries(["_layout.ts", "about.ts"], "route-");
    expect(entries.map((e) => e.path)).toEqual(["/about"]);
  });

  it("sorts static routes before dynamic and catch-all last", () => {
    const entries = buildRouteEntries(["blog/[...slug].ts", "users/[id].ts", "about.ts", "index.ts"], "route-");
    const paths = entries.map((e) => e.path);
    // catch-all must be last
    expect(paths[paths.length - 1]).toBe("/blog/*");
    // dynamic ":id" must come after all non-dynamic statics
    const idxDynamic = paths.indexOf("/users/:id");
    const idxStatic = paths.indexOf("/about");
    expect(idxStatic).toBeLessThan(idxDynamic);
  });

  it("lowercases chunk names", () => {
    const entries = buildRouteEntries(["About.ts"], "route-");
    expect(entries[0].chunkName).toBe(entries[0].chunkName.toLowerCase());
  });
});

describe("sibuRouteSplitting plugin", () => {
  it("exposes the expected plugin shape", () => {
    const plugin = sibuRouteSplitting();
    expect(plugin.name).toBe("sibu-route-splitting");
    expect(plugin.enforce).toBe("pre");
    expect(typeof plugin.resolveId).toBe("function");
    expect(typeof plugin.load).toBe("function");
    expect(typeof plugin.handleHotUpdate).toBe("function");
  });

  it("resolveId resolves the virtual module id and ignores others", () => {
    const plugin = sibuRouteSplitting();
    expect(plugin.resolveId("virtual:sibu-routes")).toBe("\0virtual:sibu-routes");
    expect(plugin.resolveId("some-other-module")).toBeUndefined();
  });

  it("load returns undefined for non-virtual ids", async () => {
    const plugin = sibuRouteSplitting();
    expect(await plugin.load("not-the-virtual-id")).toBeUndefined();
  });

  it("load returns empty routes when the routes dir does not exist", async () => {
    const plugin = sibuRouteSplitting({ routesDir: "does/not/exist/at/all" });
    const result = await plugin.load("\0virtual:sibu-routes");
    expect(result).toBe("export const routes = [];\n");
  });

  it("load generates a route module from a real temp routes directory", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = mkdtempSync(join(tmpdir(), "sibu-routes-"));
    const routesDir = join(root, "routes");
    mkdirSync(join(routesDir, "users"), { recursive: true });
    writeFileSync(join(routesDir, "index.ts"), "export default {}");
    writeFileSync(join(routesDir, "about.ts"), "export default {}");
    writeFileSync(join(routesDir, "users", "[id].ts"), "export default {}");
    writeFileSync(join(routesDir, "_layout.ts"), "export default {}");

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      const plugin = sibuRouteSplitting({ routesDir: "routes" });
      const result = (await plugin.load("\0virtual:sibu-routes")) as string;
      expect(result).toContain('import { lazy } from "sibujs";');
      expect(result).toContain("export const routes = [");
      expect(result).toContain('path: "/"');
      expect(result).toContain('path: "/about"');
      expect(result).toContain('path: "/users/:id"');
      expect(result).toContain("lazy(route0)");
      expect(result).toContain("webpackChunkName");
      // _layout.ts must be skipped
      expect(result).not.toContain("_layout");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("load respects exclude patterns", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = mkdtempSync(join(tmpdir(), "sibu-routes-ex-"));
    const { mkdirSync } = await import("node:fs");
    const routesDir = join(root, "routes");
    mkdirSync(routesDir, { recursive: true });
    writeFileSync(join(routesDir, "index.ts"), "export default {}");
    writeFileSync(join(routesDir, "secret.ts"), "export default {}");

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      const plugin = sibuRouteSplitting({ routesDir: "routes", exclude: ["secret"] });
      const result = (await plugin.load("\0virtual:sibu-routes")) as string;
      expect(result).toContain('path: "/"');
      expect(result).not.toContain("secret");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("uses absolute routesDir as-is in generated import paths", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const root = mkdtempSync(join(tmpdir(), "sibu-routes-abs-"));
    const routesDir = join(root, "routes").replace(/\\/g, "/");
    mkdirSync(routesDir, { recursive: true });
    writeFileSync(join(routesDir, "index.ts"), "export default {}");

    const plugin = sibuRouteSplitting({ routesDir });
    const result = (await plugin.load("\0virtual:sibu-routes")) as string;
    expect(result).toContain(routesDir);
  });

  describe("handleHotUpdate", () => {
    function makeCtx(file: string, getModuleById: (id: string) => unknown) {
      const invalidateModule = vi.fn();
      const send = vi.fn();
      return {
        ctx: {
          file,
          server: {
            moduleGraph: { invalidateModule, getModuleById },
            ws: { send },
          },
        },
        invalidateModule,
        send,
      };
    }

    it("invalidates the virtual module and triggers full-reload for route files", () => {
      const plugin = sibuRouteSplitting({ routesDir: "src/routes" });
      const mod = { id: "mod" };
      const { ctx, invalidateModule, send } = makeCtx("src/routes/about.ts", () => mod);
      plugin.handleHotUpdate?.(ctx);
      expect(invalidateModule).toHaveBeenCalledWith(mod);
      expect(send).toHaveBeenCalledWith({ type: "full-reload" });
    });

    it("does nothing when the module is not in the graph", () => {
      const plugin = sibuRouteSplitting({ routesDir: "src/routes" });
      const { ctx, invalidateModule, send } = makeCtx("src/routes/about.ts", () => null);
      plugin.handleHotUpdate?.(ctx);
      expect(invalidateModule).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it("ignores files outside the routes directory", () => {
      const plugin = sibuRouteSplitting({ routesDir: "src/routes" });
      const mod = { id: "mod" };
      const { ctx, invalidateModule, send } = makeCtx("src/components/Button.ts", () => mod);
      plugin.handleHotUpdate?.(ctx);
      expect(invalidateModule).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it("normalizes backslash paths when matching route files", () => {
      const plugin = sibuRouteSplitting({ routesDir: "src/routes" });
      const mod = { id: "mod" };
      const { ctx, invalidateModule } = makeCtx("src\\routes\\about.ts", () => mod);
      plugin.handleHotUpdate?.(ctx);
      expect(invalidateModule).toHaveBeenCalledWith(mod);
    });
  });
});
