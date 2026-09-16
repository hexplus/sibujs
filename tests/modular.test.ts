import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createBundle, createModuleRegistry, lazyModule, packageInfo } from "../src/plugins/modular";

// =============================================================================
// createModuleRegistry
// =============================================================================

describe("createModuleRegistry", () => {
  it("should register and resolve a module", () => {
    const registry = createModuleRegistry();
    registry.register("math", () => ({ add: (a: number, b: number) => a + b }));
    const math = registry.resolve<{ add: (a: number, b: number) => number }>("math");
    expect(math.add(2, 3)).toBe(5);
  });

  it("should cache the resolved value on subsequent calls", () => {
    const registry = createModuleRegistry();
    let callCount = 0;
    registry.register("counter", () => {
      callCount++;
      return { n: callCount };
    });

    const first = registry.resolve("counter");
    const second = registry.resolve("counter");
    expect(first).toBe(second);
    expect(callCount).toBe(1);
  });

  it("should resolve dependencies before the module itself", () => {
    const registry = createModuleRegistry();
    const order: string[] = [];

    registry.register("a", () => {
      order.push("a");
      return "A";
    });
    registry.register("b", () => {
      order.push("b");
      return "B";
    }, ["a"]);
    registry.register("c", () => {
      order.push("c");
      return "C";
    }, ["b"]);

    registry.resolve("c");
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("should throw on resolving an unregistered module", () => {
    const registry = createModuleRegistry();
    expect(() => registry.resolve("missing")).toThrow('[ModuleRegistry] Module "missing" is not registered.');
  });

  it("should detect circular dependencies", () => {
    const registry = createModuleRegistry();
    registry.register("x", () => "X", ["y"]);
    registry.register("y", () => "Y", ["x"]);

    expect(() => registry.resolve("x")).toThrow("Circular dependency detected");
  });

  it("should detect self-referencing circular dependency", () => {
    const registry = createModuleRegistry();
    registry.register("self", () => "S", ["self"]);
    expect(() => registry.resolve("self")).toThrow("Circular dependency detected");
  });

  it("has() returns true for registered modules and false otherwise", () => {
    const registry = createModuleRegistry();
    registry.register("exists", () => 1);
    expect(registry.has("exists")).toBe(true);
    expect(registry.has("nope")).toBe(false);
  });

  it("list() returns all registered module names", () => {
    const registry = createModuleRegistry();
    registry.register("alpha", () => 1);
    registry.register("beta", () => 2);
    registry.register("gamma", () => 3);
    expect(registry.list()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("deps() returns the transitive dependency graph", () => {
    const registry = createModuleRegistry();
    registry.register("core", () => "core");
    registry.register("utils", () => "utils", ["core"]);
    registry.register("app", () => "app", ["utils"]);

    const appDeps = registry.deps("app");
    expect(appDeps).toContain("core");
    expect(appDeps).toContain("utils");
    expect(appDeps).not.toContain("app");
  });

  it("deps() throws for an unregistered module", () => {
    const registry = createModuleRegistry();
    expect(() => registry.deps("ghost")).toThrow('[ModuleRegistry] Module "ghost" is not registered.');
  });

  it("reset() clears cached values so modules are re-evaluated", () => {
    const registry = createModuleRegistry();
    let counter = 0;
    registry.register("inc", () => ++counter);

    expect(registry.resolve("inc")).toBe(1);
    expect(registry.resolve("inc")).toBe(1); // cached

    registry.reset();

    expect(registry.resolve("inc")).toBe(2); // re-evaluated
  });
});

// =============================================================================
// createBundle
// =============================================================================

describe("createBundle", () => {
  it("should create a bundle with lazily evaluated properties", () => {
    let evaluated = false;
    const bundle = createBundle<{ greet: string }>({
      greet: () => {
        evaluated = true;
        return "hello";
      },
    });

    // Factory should not have been called yet
    expect(evaluated).toBe(false);

    // Access triggers lazy evaluation
    expect(bundle.greet).toBe("hello");
    expect(evaluated).toBe(true);
  });

  it("should cache values after first access", () => {
    let callCount = 0;
    const bundle = createBundle<{ value: number }>({
      value: () => {
        callCount++;
        return 42;
      },
    });

    expect(bundle.value).toBe(42);
    expect(bundle.value).toBe(42);
    expect(callCount).toBe(1);
  });

  it("should support multiple keys independently", () => {
    const calls: string[] = [];
    const bundle = createBundle<{ a: string; b: string }>({
      a: () => {
        calls.push("a");
        return "A";
      },
      b: () => {
        calls.push("b");
        return "B";
      },
    });

    // Access only 'b'
    expect(bundle.b).toBe("B");
    expect(calls).toEqual(["b"]);

    // Now access 'a'
    expect(bundle.a).toBe("A");
    expect(calls).toEqual(["b", "a"]);
  });

  it("should enumerate bundle keys", () => {
    const bundle = createBundle<{ x: number; y: number }>({
      x: () => 1,
      y: () => 2,
    });

    expect(Object.keys(bundle)).toEqual(["x", "y"]);
  });
});

// =============================================================================
// lazyModule
// =============================================================================

describe("lazyModule", () => {
  it("should not be loaded initially", () => {
    const mod = lazyModule(async () => ({ version: "1.0" }));
    expect(mod.loaded).toBe(false);
  });

  it("should load and cache the module on first get()", async () => {
    let loadCount = 0;
    const mod = lazyModule(async () => {
      loadCount++;
      return { data: "loaded" };
    });

    const result = await mod.get();
    expect(result).toEqual({ data: "loaded" });
    expect(mod.loaded).toBe(true);
    expect(loadCount).toBe(1);

    // Second call returns cached value
    const result2 = await mod.get();
    expect(result2).toEqual({ data: "loaded" });
    expect(loadCount).toBe(1);
  });

  it("should handle async loaders that return primitive values", async () => {
    const mod = lazyModule(async () => 99);
    const value = await mod.get();
    expect(value).toBe(99);
    expect(mod.loaded).toBe(true);
  });

  it("should propagate loader errors", async () => {
    const mod = lazyModule(async () => {
      throw new Error("load failed");
    });

    await expect(mod.get()).rejects.toThrow("load failed");
  });
});

// =============================================================================
// packageInfo
// =============================================================================

describe("packageInfo", () => {
  // packageInfo used to hard-code a different package ("sibu" 1.0.0) with
  // `.mjs` outputs, nonexistent source paths and subpaths the real package does
  // not export. It is now checked against the package's own manifest, build
  // script and (when built) dist output, so it cannot drift again silently.
  const ROOT = resolve(__dirname, "..");
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    name: string;
    version: string;
    scripts: Record<string, string>;
    exports: Record<string, Record<string, string>>;
  };

  it("name and version match package.json", () => {
    expect(packageInfo.name).toBe(pkg.name);
    expect(packageInfo.version).toBe(pkg.version);
  });

  it("generates exactly the exports map declared in package.json", () => {
    expect(packageInfo.generateExportsMap()).toEqual(pkg.exports);
  });

  it("every module entry point is a source file the build script compiles", () => {
    const buildEntries = pkg.scripts.build
      .split("&&")[0]
      .split(/\s+/)
      .filter((part) => part.endsWith(".ts"));
    const entrySources = Object.values(packageInfo.entryPoints).map((p) => p.replace(/^\.\//, ""));

    expect([...entrySources].sort()).toEqual([...buildEntries].sort());
    for (const source of entrySources) {
      expect(existsSync(resolve(ROOT, source)), `${source} exists`).toBe(true);
    }
  });

  const distBuilt = existsSync(resolve(ROOT, "dist/index.js"));
  it.skipIf(!distBuilt)("every generated target exists in the built dist", () => {
    for (const [subpath, targets] of Object.entries(packageInfo.generateExportsMap())) {
      for (const target of Object.values(targets)) {
        expect(existsSync(resolve(ROOT, target)), `${subpath} → ${target}`).toBe(true);
      }
    }
  });
});
