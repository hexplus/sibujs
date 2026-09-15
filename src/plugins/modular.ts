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
export function createBundle<T extends object>(modules: Record<string, () => unknown>): T {
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

/** Handle returned by {@link lazyModule}. */
export interface LazyModule<T> {
  /** Whether a load has completed successfully. Read-only. */
  readonly loaded: boolean;
  /** Load the module (once) and resolve to it. Concurrent calls share one load. */
  get(): Promise<T>;
}

/**
 * Lazy module loader that only imports a module when first accessed.
 * Uses ES module dynamic import under the hood.
 * Caches the result after the first successful load.
 *
 * Concurrent `get()` calls made before the first load settles share that one
 * load. A failed load is not cached: the next `get()` retries.
 */
export function lazyModule<T>(loader: () => Promise<T>): LazyModule<T> {
  let cached: T | undefined;
  let loadedFlag = false;
  // The load in progress, shared by every caller that arrives before it
  // settles. Filling the cache only after `await loader()` let each of those
  // callers start its own load — duplicate side effects, per-caller results,
  // and a cached value decided by settlement order.
  let inFlight: Promise<T> | null = null;

  return {
    get loaded() {
      return loadedFlag;
    },
    get(): Promise<T> {
      // Gate on the flag alone — a loader that legitimately resolves to
      // `undefined` (or a falsy module) must still be cached, not re-invoked
      // (which would re-run side-effectful imports) on every get().
      if (loadedFlag) return Promise.resolve(cached as T);
      if (inFlight) return inFlight;

      // Invoke the loader synchronously, as before; a synchronous throw becomes
      // a rejection of the shared attempt.
      let started: Promise<T>;
      try {
        started = Promise.resolve(loader());
      } catch (err) {
        started = Promise.reject(err);
      }
      const attempt: Promise<T> = started.then(
        (value) => {
          cached = value;
          loadedFlag = true;
          if (inFlight === attempt) inFlight = null;
          return value;
        },
        (err: unknown) => {
          // Only the attempt that still owns the slot may clear it.
          if (inFlight === attempt) inFlight = null;
          throw err;
        },
      );
      inFlight = attempt;
      return attempt;
    },
  };
}

// ─── Package Metadata ───────────────────────────────────────────────────────

// Stamped by the build from package.json (see tsup.config.ts); the test runner
// defines it the same way. Only raw, unbundled source falls back to "dev".
declare const __SIBU_VERSION__: string | undefined;

/**
 * The package's module entry points: export subpath name → root source file.
 * Mirrors the entry list in the `build` script and `exports` in package.json;
 * `tests/modular.test.ts` fails if any of the three drift apart.
 */
const MODULE_ENTRY_POINTS: Record<string, string> = {
  main: "./index.ts",
  data: "./data.ts",
  browser: "./browser.ts",
  patterns: "./patterns.ts",
  motion: "./motion.ts",
  ui: "./ui.ts",
  widgets: "./widgets.ts",
  ssr: "./ssr.ts",
  devtools: "./devtools.ts",
  performance: "./performance.ts",
  ecosystem: "./ecosystem.ts",
  plugins: "./plugins.ts",
  build: "./build.ts",
  testing: "./testing.ts",
  extras: "./extras.ts",
};

/** Prebuilt CDN scripts: export subpath name → IIFE file emitted by tsup.cdn.config.ts. */
const CDN_ENTRY_POINTS: Record<string, string> = {
  cdn: "./dist/cdn.global.js",
  "cdn-dev": "./dist/cdn.dev.global.js",
  "cdn-full": "./dist/cdn.full.global.js",
  "cdn-full-dev": "./dist/cdn.full.dev.global.js",
};

/** One `exports` entry: a module entry point, or a prebuilt CDN script. */
export type PackageExportTarget = { types: string; import: string; require: string } | { default: string };

/**
 * Package metadata for distribution tooling.
 * Provides entry point information and generates the Node.js subpath exports
 * map that the published package actually uses.
 */
export const packageInfo = {
  name: "sibujs",
  version: typeof __SIBU_VERSION__ !== "undefined" ? __SIBU_VERSION__ : "dev",
  entryPoints: MODULE_ENTRY_POINTS,

  /**
   * Generate the package.json `exports` map. Module entries resolve to the
   * `.js` (ESM), `.cjs` and `.d.ts` files tsup emits into `dist/`; CDN entries
   * resolve to their prebuilt global script.
   */
  generateExportsMap(): Record<string, PackageExportTarget> {
    const exportsMap: Record<string, PackageExportTarget> = {};

    for (const [name, sourcePath] of Object.entries(MODULE_ENTRY_POINTS)) {
      const distPath = sourcePath.replace(/^\.\//, "./dist/").replace(/\.ts$/, "");
      const subpath = name === "main" ? "." : `./${name}`;
      exportsMap[subpath] = {
        types: `${distPath}.d.ts`,
        import: `${distPath}.js`,
        require: `${distPath}.cjs`,
      };
    }

    for (const [name, file] of Object.entries(CDN_ENTRY_POINTS)) {
      exportsMap[`./${name}`] = { default: file };
    }

    return exportsMap;
  },
};
