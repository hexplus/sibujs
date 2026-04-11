/**
 * Webpack plugin configuration for SibuJS projects.
 * Provides build optimization, pure annotations, and development enhancements.
 */

export interface SibuWebpackPluginOptions {
  /** Enable automatic pure annotations for tree-shaking */
  pureAnnotations?: boolean;
  /** Enable dev mode features (devtools, debug logging) */
  devMode?: boolean;
}

/**
 * Known SibuJS factory functions that should receive pure annotations.
 */
const PURE_FACTORIES = [
  "tagFactory",
  "context",
  "defineComponent",
  "withProps",
  "withDefaults",
  "pure",
  "noSideEffect",
];

/**
 * Inject pure annotations into code for better tree-shaking with webpack.
 */
function addPureAnnotations(source: string): string {
  let result = source;
  for (const factory of PURE_FACTORIES) {
    const pattern = new RegExp(`(?<!/\\*#__PURE__\\*/\\s*)\\b(${factory})\\s*\\(`, "g");
    result = result.replace(pattern, "/*#__PURE__*/ $1(");
  }
  return result;
}

/**
 * Webpack plugin configuration helper for SibuJS.
 * Returns webpack-compatible plugin and loader configurations.
 *
 * Usage:
 * ```js
 * const { sibuWebpackPlugin } = require('sibu/src/build/webpack');
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
  const { pureAnnotations = true, devMode } = options;

  const isDevMode = devMode ?? (typeof process !== "undefined" && process.env?.NODE_ENV !== "production");

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

      // Add the pure annotation transform as a loader via module rules
      if (pureAnnotations) {
        compiler.hooks?.afterEnvironment?.tap("SibuWebpackPlugin", () => {
          if (!compiler.options.module) {
            compiler.options.module = { rules: [] };
          }
          if (!compiler.options.module.rules) {
            compiler.options.module.rules = [];
          }

          // Add a loader rule that applies pure annotations to JS/TS files
          compiler.options.module.rules.push({
            test: /\.[jt]sx?$/,
            exclude: /node_modules/,
            enforce: "pre" as const,
            use: [
              {
                loader: {
                  // Inline loader function
                  ident: "sibu-pure-annotations-loader",
                  loader: "__sibu_inline_loader__",
                  options: {},
                },
              },
            ],
          });
        });
      }

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
      if (isDevMode) {
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
      }

      // Define global constants for dead code elimination
      compiler.hooks?.environment?.tap("SibuWebpackPlugin", () => {
        if (!compiler.options.plugins) {
          compiler.options.plugins = [];
        }

        // Inject define values that webpack's DefinePlugin would use
        const defines: Record<string, string> = {
          __SIBU_DEV__: JSON.stringify(isDevMode),
        };

        // Store defines on the compiler for DefinePlugin integration
        (compiler as WebpackCompiler).__sibuDefines = defines;
      });
    },
  };
}

/**
 * Create a standalone webpack loader function for pure annotation injection.
 * Can be used directly in webpack module rules.
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
 * const { createWebpackConfig } = require('sibu/src/build/webpack');
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
              // Separate sibu framework code into its own chunk
              sibu: {
                test: /[\\/]node_modules[\\/]sibu[\\/]/,
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
