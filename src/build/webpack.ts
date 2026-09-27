/**
 * Webpack plugin configuration for SibuJS projects.
 * Provides build optimization, pure annotations, and development enhancements.
 */

import { injectPureAnnotations } from "./sourceScan";

export interface SibuWebpackPluginOptions {
  /**
   * Accepted for API compatibility; the plugin itself no longer injects a
   * loader. Webpack loaders must be resolvable modules, and the rule this
   * plugin used to push named a loader that does not exist
   * (`__sibu_inline_loader__`), which failed every build with the default
   * options. To get pure annotations, reference a loader file that returns
   * `createPureAnnotationsLoader()(source)`.
   */
  pureAnnotations?: boolean;
  /**
   * Enable dev mode features (devtools, debug logging). When omitted it is
   * derived from webpack's own resolved `mode`: `development` is dev,
   * `production` and an unset mode (webpack's default is production) are not,
   * and `mode: "none"` falls back to `NODE_ENV`.
   */
  devMode?: boolean;
}

/**
 * Inject pure annotations into code for better tree-shaking with webpack.
 *
 * Shares the scanner-based implementation with the Vite plugin: only direct
 * calls to factories imported from sibujs are annotated — never method calls,
 * function declarations, text inside strings/comments/templates, or a user
 * function that merely shares a factory's name. A wrong pure annotation lets
 * the minifier delete a call that has side effects.
 */
function addPureAnnotations(source: string): string {
  return injectPureAnnotations(source);
}

/**
 * Webpack plugin configuration helper for SibuJS.
 * Returns webpack-compatible plugin and loader configurations.
 *
 * Usage:
 * ```js
 * const { sibuWebpackPlugin } = require('sibujs/build');
 * module.exports = {
 *   plugins: [sibuWebpackPlugin()],
 * };
 * ```
 */
/** Minimal webpack compiler interface for plugin compatibility. */
interface WebpackCompiler {
  hooks?: Record<string, { tap: (name: string, callback: (...args: unknown[]) => void) => void } | undefined>;
  options: {
    module?: { rules?: unknown[] };
    resolve?: { mainFields?: string[] };
    plugins?: unknown[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function sibuWebpackPlugin(options: SibuWebpackPluginOptions = {}): {
  /** Plugin name */
  name: string;
  /** Apply function for webpack plugin API */
  apply: (compiler: WebpackCompiler) => void;
} {
  const { devMode } = options;

  return {
    name: "SibuWebpackPlugin",

    apply(compiler: WebpackCompiler): void {
      // Inject global defines via webpack's DefinePlugin-compatible mechanism
      compiler.hooks?.compilation?.tap("SibuWebpackPlugin", (compilation: unknown) => {
        // Register define expressions for dead code elimination
        const comp = compilation as {
          hooks?: Record<string, { tap: (name: string, cb: () => void) => void } | undefined>;
        };
        if (comp.hooks?.optimizeModules) {
          comp.hooks.optimizeModules.tap("SibuWebpackPlugin", () => {
            // Module optimization phase - webpack handles tree-shaking here
          });
        }
      });

      // Add resolver alias for sibu modules
      compiler.hooks?.afterResolvers?.tap("SibuWebpackPlugin", () => {
        if (!compiler.options.resolve) {
          compiler.options.resolve = {};
        }
        if (!compiler.options.resolve.mainFields) {
          compiler.options.resolve.mainFields = ["module", "main"];
        }
        // Ensure 'module' field is checked first for ESM builds
        if (!compiler.options.resolve.mainFields.includes("module")) {
          compiler.options.resolve.mainFields.unshift("module");
        }
      });

      // Emit build information in dev mode
      const tapDoneLogger = () =>
        compiler.hooks?.done?.tap("SibuWebpackPlugin", (stats: unknown) => {
          const statsObj = stats as { toJson?: (opts: Record<string, boolean>) => Record<string, unknown> } | undefined;
          const info = statsObj?.toJson?.({ modules: false, chunks: false });
          if (info) {
            console.log(`[SibuWebpackPlugin] Build completed in ${(info.time as number) || 0}ms`);
            const warnings = info.warnings as unknown[] | undefined;
            if (warnings?.length) {
              console.log(`[SibuWebpackPlugin] ${warnings.length} warning(s)`);
            }
          }
        });

      // An explicit option needs nothing from webpack and is decided now.
      if (devMode === true) tapDoneLogger();

      // Everything mode-dependent is decided in `environment`, NOT here.
      // webpack 5 calls `apply()` on the configured plugins BEFORE it applies
      // its option defaults, so `compiler.options.mode` is still `undefined`
      // here when the config does not set it — and the old fallback to
      // NODE_ENV (usually unset, i.e. "development") put
      // `__SIBU_DEV__ = true` into production bundles. `environment` fires
      // after the defaults are applied.
      compiler.hooks?.environment?.tap("SibuWebpackPlugin", () => {
        const isDevMode = devMode ?? resolveWebpackDevMode(compiler.options);
        if (devMode === undefined && isDevMode) tapDoneLogger();

        if (!compiler.options.plugins) {
          compiler.options.plugins = [];
        }

        // Inject define values that webpack's DefinePlugin would use
        const defines: Record<string, string> = {
          __SIBU_DEV__: JSON.stringify(isDevMode),
        };

        // Store defines on the compiler for DefinePlugin integration
        (compiler as WebpackCompiler).__sibuDefines = defines;
        // Apply them when running under a real webpack (5+ exposes its API on
        // the compiler). Storing them alone never reached the bundle.
        const DefinePlugin = (compiler as { webpack?: { DefinePlugin?: new (d: Record<string, string>) => unknown } })
          .webpack?.DefinePlugin;
        if (DefinePlugin) {
          (new DefinePlugin(defines) as { apply: (c: WebpackCompiler) => void }).apply(compiler);
        }
      });
    },
  };
}

/**
 * Dev mode from webpack's options once its defaults are applied. webpack
 * treats an unset `mode` as production (it may keep `mode` itself undefined
 * and only derive production defaults from it, such as
 * `optimization.nodeEnv: "production"`). Only `mode: "none"` carries no
 * answer, and falls back to `NODE_ENV`.
 */
function resolveWebpackDevMode(options: WebpackCompiler["options"]): boolean {
  const mode = options.mode;
  if (mode === "development") return true;
  if (mode === "production" || mode === undefined) return false;
  return typeof process !== "undefined" && process.env?.NODE_ENV !== "production";
}

/**
 * Create a standalone webpack loader function for pure annotation injection.
 *
 * Webpack resolves loaders by path, so wrap it in a loader module and point a
 * rule at that file:
 * ```js
 * // sibu-pure-loader.cjs
 * const { createPureAnnotationsLoader } = require("sibujs/build");
 * module.exports = createPureAnnotationsLoader();
 * ```
 */
export function createPureAnnotationsLoader(): (source: string) => string {
  return function sibuPureAnnotationsLoader(source: string): string {
    return addPureAnnotations(source);
  };
}

/**
 * Generate Webpack configuration for SibuJS projects.
 *
 * Usage:
 * ```js
 * const { createWebpackConfig } = require('sibujs/build');
 * module.exports = createWebpackConfig({
 *   entry: './src/index.ts',
 *   mode: 'production',
 * });
 * ```
 */
export function createWebpackConfig(
  options: {
    /** Entry point file */
    entry?: string;
    /** Output directory path */
    outputPath?: string;
    /** Build mode */
    mode?: "development" | "production";
  } = {},
): Record<string, unknown> {
  const { entry = "./src/index.ts", outputPath = "dist", mode = "production" } = options;

  const isDev = mode === "development";

  return {
    mode,
    entry,

    output: {
      path: outputPath,
      filename: isDev ? "[name].js" : "[name].[contenthash:8].js",
      chunkFilename: isDev ? "[name].chunk.js" : "[name].[contenthash:8].chunk.js",
      clean: true,
      // Use ESM output
      module: true,
      library: {
        type: "module",
      },
    },

    // Enable experiments for ESM output
    experiments: {
      outputModule: true,
    },

    resolve: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
      mainFields: ["module", "main"],
      alias: {},
    },

    module: {
      rules: [
        // TypeScript/JavaScript handling
        {
          test: /\.[jt]sx?$/,
          exclude: /node_modules/,
          use: [
            {
              // Users should configure their preferred TS loader
              // (ts-loader, babel-loader, esbuild-loader, swc-loader)
              loader: "ts-loader",
              options: {
                transpileOnly: true,
                compilerOptions: {
                  module: "esnext",
                  moduleResolution: "node",
                  target: "es2020",
                },
              },
            },
          ],
        },
      ],
    },

    plugins: [
      // SibuJS plugin for optimizations
      sibuWebpackPlugin({ devMode: isDev }),
    ],

    optimization: {
      minimize: !isDev,
      // Enable tree-shaking
      usedExports: true,
      sideEffects: true,
      // Split chunks for better caching
      splitChunks: isDev
        ? false
        : {
            chunks: "all",
            cacheGroups: {
              // Separate sibujs framework code into its own chunk (the package
              // directory is `sibujs`; matching `sibu` never selected anything)
              sibu: {
                test: /[\\/]node_modules[\\/]sibujs[\\/]/,
                name: "sibu",
                chunks: "all",
                priority: 20,
              },
              // Separate other vendor code
              vendor: {
                test: /[\\/]node_modules[\\/]/,
                name: "vendor",
                chunks: "all",
                priority: 10,
              },
            },
          },
    },

    // Source maps
    devtool: isDev ? "eval-cheap-module-source-map" : "source-map",

    // Dev server configuration
    devServer: isDev
      ? {
          hot: true,
          open: true,
          port: 3000,
          historyApiFallback: true,
        }
      : undefined,

    // Performance hints
    performance: {
      hints: isDev ? false : "warning",
      maxEntrypointSize: 250000,
      maxAssetSize: 250000,
    },

    // Cache for faster rebuilds
    cache: {
      type: "filesystem",
      buildDependencies: {
        config: [],
      },
    },
  };
}
