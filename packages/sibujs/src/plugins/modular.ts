// ============================================================================
// MODULAR DISTRIBUTION
// ============================================================================

/**
 * Modular distribution utilities for SibuJS.
 * Enables granular imports and micro-package consumption patterns.
 */

// ─── Module Registry ────────────────────────────────────────────────────────

/**
 * Module registry for tracking available modules and their dependencies.
 * Supports lazy initialization and automatic dependency resolution.
 */
export function createModuleRegistry() {
  const modules = new Map<string, { factory: () => unknown; deps: string[]; loaded: boolean; value?: unknown }>();

  /**
   * Topologically resolve a module, detecting circular dependencies.
   */
  function resolveInternal(name: string, stack: Set<string>): unknown {
    const entry = modules.get(name);
    if (!entry) {
      throw new Error(`[ModuleRegistry] Module "${name}" is not registered.`);
    }

    // Return cached value if already loaded
    if (entry.loaded) {
      return entry.value;
    }

    // Circular dependency detection
    if (stack.has(name)) {
      const cycle = [...stack, name].join(" -> ");
      throw new Error(`[ModuleRegistry] Circular dependency detected: ${cycle}`);
    }

    stack.add(name);

    // Resolve dependencies first
    for (const dep of entry.deps) {
      resolveInternal(dep, stack);
    }

    stack.delete(name);

    // Initialize the module
    entry.value = entry.factory();
    entry.loaded = true;
    return entry.value;
  }

  return {
    /** Register a module with its factory function and optional dependencies */
    register(name: string, factory: () => unknown, deps: string[] = []): void {
      modules.set(name, { factory, deps, loaded: false });
    },

    /** Resolve a module, loading its dependencies first */
    resolve<T = unknown>(name: string): T {
      return resolveInternal(name, new Set<string>()) as T;
    },

    /** Check if a module is registered */
    has(name: string): boolean {
      return modules.has(name);
    },

    /** List all registered module names */
    list(): string[] {
      return Array.from(modules.keys());
    },

    /** Get the full dependency graph (transitive) for a module */
    deps(name: string): string[] {
      const entry = modules.get(name);
      if (!entry) {
        throw new Error(`[ModuleRegistry] Module "${name}" is not registered.`);
      }

      const visited = new Set<string>();
      const result: string[] = [];

      function walk(modName: string): void {
        const mod = modules.get(modName);
        if (!mod) return;
        for (const dep of mod.deps) {
          if (!visited.has(dep)) {
            visited.add(dep);
            walk(dep);
            result.push(dep);
          }
        }
      }

      walk(name);
      return result;
    },

    /** Reset all loaded modules back to unloaded state (useful for testing) */
    reset(): void {
      for (const entry of modules.values()) {
        entry.loaded = false;
        entry.value = undefined;
      }
    },
  };
}

// ─── Bundle Creator ─────────────────────────────────────────────────────────

/**
 * Create a subset bundle containing only specified modules.
 * Each key maps to a factory function that is invoked lazily on first access.
 * Returns an object with only the requested exports.
 */
export function createBundle<T extends Record<string, unknown>>(modules: Record<string, () => unknown>): T {
  const cache = new Map<string, unknown>();
  const bundle = {} as Record<string, unknown>;

  for (const key of Object.keys(modules)) {
    Object.defineProperty(bundle, key, {
      get() {
        if (cache.has(key)) {
          return cache.get(key);
        }
        const value = modules[key]();
        cache.set(key, value);
        return value;
      },
      enumerable: true,
      configurable: false,
    });
  }

  return bundle as T;
}

// ─── Lazy Module Loader ─────────────────────────────────────────────────────

/**
 * Lazy module loader that only imports a module when first accessed.
 * Uses ES module dynamic import under the hood.
 * Caches the result after the first successful load.
 */
export function lazyModule<T>(loader: () => Promise<T>): { get: () => Promise<T>; loaded: boolean } {
  let cached: T | undefined;
  let loadedFlag = false;

  const handle = {
    get loaded() {
      return loadedFlag;
    },
    async get(): Promise<T> {
      // Gate on the flag alone — a loader that legitimately resolves to
      // `undefined` (or a falsy module) must still be cached, not re-invoked
      // (which would re-run side-effectful imports) on every get().
      if (loadedFlag) return cached as T;
      cached = await loader();
      loadedFlag = true;
      return cached;
    },
  };

  return handle;
}

// ─── Package Metadata ───────────────────────────────────────────────────────

/**
 * Package metadata for distribution tooling.
 * Provides entry point information and can generate Node.js subpath exports maps.
 */
export const packageInfo = {
  name: "sibujs",
  version: "4.0.0-alpha.0",
  // Published entry points, matching the package's real build inputs and
  // `exports` map (each maps to a `dist/<name>.*` bundle).
  entryPoints: {
    main: "./index.ts",
    data: "./data.ts",
    ui: "./ui.ts",
    ssr: "./ssr.ts",
    plugins: "./plugins.ts",
    build: "./build.ts",
    testing: "./testing.ts",
  } as Record<string, string>,

  /**
   * Generate a package.json `exports` map for Node.js subpath exports.
   * Maps each entry point to its import, require, and types paths.
   */
  generateExportsMap(): Record<string, { import: string; require: string; types: string }> {
    const exportsMap: Record<string, { import: string; require: string; types: string }> = {};

    for (const [name, sourcePath] of Object.entries(this.entryPoints)) {
      // Convert the .ts source path to its dist output base path.
      const distPath = sourcePath.replace(/^\.\//, "./dist/").replace(/\.ts$/, "");

      const subpath = name === "main" ? "." : `./${name}`;

      exportsMap[subpath] = {
        import: `${distPath}.js`,
        require: `${distPath}.cjs`,
        types: `${distPath}.d.ts`,
      };
    }

    return exportsMap;
  },
};
