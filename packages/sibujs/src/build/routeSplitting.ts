/**
 * Vite plugin for automatic route-based code splitting.
 * Scans a routes directory and generates lazy-loaded route definitions.
 */

export interface RouteSplittingOptions {
  /** Directory containing route files (default: "src/routes") */
  routesDir?: string;
  /** Glob patterns to exclude */
  exclude?: string[];
  /** Chunk name prefix (default: "route-") */
  chunkPrefix?: string;
}

interface RouteEntry {
  /** URL path pattern (e.g., "/users/:id") */
  path: string;
  /** Import path relative to project root */
  importPath: string;
  /** Generated chunk name */
  chunkName: string;
  /** Whether route has dynamic segments */
  isDynamic: boolean;
}

/**
 * Convert a file path within the routes directory to a URL pattern.
 *
 * Conventions:
 * - index.ts -> /
 * - about.ts -> /about
 * - users/[id].ts -> /users/:id
 * - blog/[...slug].ts -> /blog/*
 * - _layout.ts -> skipped (layout file)
 * - _middleware.ts -> skipped
 */
function fileToRoute(relativePath: string): string | null {
  // Skip layout and middleware files
  const basename = relativePath.split("/").pop() || "";
  if (basename.startsWith("_")) return null;

  // Remove extension
  let route = relativePath.replace(/\.(ts|tsx|js|jsx)$/, "");

  // Convert index to /
  route = route.replace(/\/index$/, "").replace(/^index$/, "");

  // Convert [param] to :param
  route = route.replace(/\[\.\.\.(\w+)\]/g, "*");
  route = route.replace(/\[(\w+)\]/g, ":$1");

  return `/${route}`;
}

/**
 * Scan a directory recursively for route files.
 * Returns relative paths from the routes directory.
 */
async function scanRoutes(
  routesDir: string,
  exclude: string[],
  fs: {
    readdir: (
      path: string,
      opts: { withFileTypes: boolean; recursive?: boolean },
    ) => Promise<Array<{ name: string; isFile: () => boolean; parentPath?: string; path?: string }>>;
  },
): Promise<string[]> {
  const entries = await fs.readdir(routesDir, { withFileTypes: true, recursive: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;

    // Build relative path
    const dir = (entry.parentPath || entry.path || routesDir).replace(/\\/g, "/");
    const routesDirNorm = routesDir.replace(/\\/g, "/");
    const relative = `${dir}/${entry.name}`.replace(`${routesDirNorm}/`, "").replace(/\\/g, "/");

    // Check exclusions
    const excluded = exclude.some((pattern) => {
      const regex = pattern.replace(/\*/g, ".*");
      return new RegExp(regex).test(relative);
    });
    if (!excluded) {
      files.push(relative);
    }
  }

  return files.sort();
}

/**
 * Generate route entries from scanned files.
 */
function buildRouteEntries(files: string[], chunkPrefix: string): RouteEntry[] {
  const entries: RouteEntry[] = [];

  for (const file of files) {
    const path = fileToRoute(file);
    if (path === null) continue;

    const chunkName = `${chunkPrefix}${file
      .replace(/\.(ts|tsx|js|jsx)$/, "")
      .replace(/[/\\[\].]/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()}`;

    entries.push({
      path,
      importPath: file,
      chunkName,
      isDynamic: path.includes(":") || path.includes("*"),
    });
  }

  // Sort: static routes first, then dynamic, then catch-all
  return entries.sort((a, b) => {
    if (a.path.includes("*") && !b.path.includes("*")) return 1;
    if (!a.path.includes("*") && b.path.includes("*")) return -1;
    if (a.isDynamic && !b.isDynamic) return 1;
    if (!a.isDynamic && b.isDynamic) return -1;
    return a.path.localeCompare(b.path);
  });
}

/**
 * Generate the virtual module code that exports lazy routes.
 */
function generateRouteModule(entries: RouteEntry[], routesDir: string): string {
  const imports = entries
    .map(
      (e, i) =>
        `const route${i} = () => import(/* webpackChunkName: "${e.chunkName}" */ "${routesDir}/${e.importPath}");`,
    )
    .join("\n");

  const routes = entries.map((e, i) => `  { path: "${e.path}", component: lazy(route${i}) }`).join(",\n");

  return `import { lazy } from "sibu";\n\n${imports}\n\nexport const routes = [\n${routes}\n];\n`;
}

const VIRTUAL_ID = "virtual:sibu-routes";
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;

/**
 * Vite plugin for automatic route-based code splitting.
 *
 * Scans the routes directory and generates a virtual module `virtual:sibu-routes`
 * that exports lazy-loaded route definitions compatible with Sibu's router.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { sibuVitePlugin } from "sibu/build";
 * import { sibuRouteSplitting } from "sibu/build";
 *
 * export default {
 *   plugins: [sibuVitePlugin(), sibuRouteSplitting()],
 * };
 *
 * // In your app:
 * import { routes } from "virtual:sibu-routes";
 * import { setRoutes } from "sibu/plugins";
 * setRoutes(routes);
 * ```
 */
export function sibuRouteSplitting(options: RouteSplittingOptions = {}): {
  name: string;
  enforce: "pre";
  resolveId: (id: string) => string | undefined;
  load: (id: string) => Promise<string | undefined>;
  handleHotUpdate?: (ctx: {
    file: string;
    server: {
      moduleGraph: { invalidateModule: (mod: unknown) => void; getModuleById: (id: string) => unknown };
      ws: { send: (msg: unknown) => void };
    };
  }) => void;
} {
  const { routesDir = "src/routes", exclude = [], chunkPrefix = "route-" } = options;

  let projectRoot = "";

  return {
    name: "sibu-route-splitting",
    enforce: "pre",

    resolveId(id: string) {
      if (id === VIRTUAL_ID) {
        return RESOLVED_VIRTUAL_ID;
      }
      return undefined;
    },

    async load(id: string) {
      if (id !== RESOLVED_VIRTUAL_ID) return undefined;

      // Dynamically import fs and path (Node.js only, build time)
      const { readdir } = await import("node:fs/promises");
      const { resolve } = await import("node:path");

      // Resolve project root from Vite config or cwd
      if (!projectRoot) {
        projectRoot = process.cwd();
      }

      const fullRoutesDir = resolve(projectRoot, routesDir);

      try {
        const files = await scanRoutes(fullRoutesDir, exclude, {
          readdir: readdir as Parameters<typeof scanRoutes>[2]["readdir"],
        });
        const entries = buildRouteEntries(files, chunkPrefix);
        return generateRouteModule(entries, routesDir.startsWith("/") ? routesDir : `./${routesDir}`);
      } catch {
        // Routes directory doesn't exist yet — return empty routes
        return "export const routes = [];\n";
      }
    },

    handleHotUpdate(ctx) {
      const normalizedRoutesDir = routesDir.replace(/\\/g, "/");
      if (ctx.file.replace(/\\/g, "/").includes(normalizedRoutesDir)) {
        // Invalidate the virtual module when route files change
        const mod = ctx.server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID);
        if (mod) {
          ctx.server.moduleGraph.invalidateModule(mod);
          ctx.server.ws.send({ type: "full-reload" });
        }
      }
    },
  };
}

// Export helpers for testing
export { buildRouteEntries, fileToRoute };
