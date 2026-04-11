/**
 * Official Vite plugin for SibuJS.
 * Provides optimized builds, automatic component detection, and development enhancements.
 */

import { compileHtmlTemplates } from "./compileTemplates";
import { analyzeStaticTemplates } from "./staticAnalysis";

export interface SibuVitePluginOptions {
  /** Enable HMR support for SibuJS components */
  hmr?: boolean;
  /** Enable automatic pure annotations for tree-shaking */
  pureAnnotations?: boolean;
  /** Component file patterns to watch */
  include?: string[];
  /** File patterns to exclude */
  exclude?: string[];
  /** Enable dev mode features (devtools, debug logging) */
  devMode?: boolean;
  /** Enable static template optimization (default: true in production) */
  staticOptimize?: boolean;
  /** Compile html`` tagged templates to direct function calls (default: true in production) */
  compileTemplates?: boolean;
}

/**
 * Default file patterns for SibuJS component files.
 */
const SVG_TAGS_SET = new Set([
  "svg",
  "circle",
  "ellipse",
  "g",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
  "tspan",
  "defs",
  "clipPath",
  "mask",
  "pattern",
  "linearGradient",
  "radialGradient",
  "stop",
  "use",
  "symbol",
  "marker",
]);

const DEFAULT_INCLUDE = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"];
const DEFAULT_EXCLUDE = ["node_modules/**", "dist/**", "**/*.test.*", "**/*.spec.*"];

/**
 * Check if a file path matches any of the given glob-like patterns.
 * Supports basic wildcard patterns: *, **, and file extensions.
 */
function matchesPattern(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return patterns.some((pattern) => {
    const regexStr = pattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "{{GLOBSTAR}}")
      .replace(/\*/g, "[^/]*")
      .replace(/\{\{GLOBSTAR\}\}/g, ".*");
    return new RegExp(regexStr).test(normalized);
  });
}

/**
 * Inject pure annotations into SibuJS function calls for better tree-shaking.
 * Adds \/\*#__PURE__\*\/ comments before known SibuJS factory calls.
 */
function injectPureAnnotations(code: string): string {
  const sibuFactories = [
    "tagFactory",
    "context",
    "defineComponent",
    "withProps",
    "withDefaults",
    "pure",
    "noSideEffect",
  ];

  let result = code;
  for (const factory of sibuFactories) {
    // Match calls like: tagFactory("div") that are not already annotated
    const pattern = new RegExp(`(?<!/\\*#__PURE__\\*/\\s*)\\b(${factory})\\s*\\(`, "g");
    result = result.replace(pattern, "/*#__PURE__*/ $1(");
  }
  return result;
}

/**
 * Inject development mode helpers into the code.
 * Adds enableDebug() calls and performance instrumentation in dev mode.
 */
function injectDevHelpers(code: string): string {
  // Add dev-mode global flag if the file imports from sibu
  if (
    code.includes('from "sibu"') ||
    code.includes("from 'sibu'") ||
    code.includes('from "sibu/') ||
    code.includes("from 'sibu/")
  ) {
    return `/* SibuJS Dev Mode */\nif (typeof globalThis !== 'undefined') { (globalThis as unknown as Record<string, unknown>).__SIBU_DEV__ = true; }\n${code}`;
  }
  return code;
}

/**
 * Vite plugin configuration for SibuJS projects.
 * Returns a Vite-compatible plugin object.
 *
 * Note: This is a configuration helper. For full Vite plugin functionality,
 * users should install @sibu/vite-plugin (when available).
 */
export function sibuVitePlugin(options: SibuVitePluginOptions = {}): {
  name: string;
  enforce?: "pre" | "post";
  config?: () => Record<string, unknown>;
  transform?: (code: string, id: string) => { code: string; map?: unknown } | null;
  handleHotUpdate?: (ctx: { file: string; modules: unknown[] }) => void;
} {
  const {
    hmr = true,
    pureAnnotations = true,
    include = DEFAULT_INCLUDE,
    exclude = DEFAULT_EXCLUDE,
    devMode,
    staticOptimize,
    compileTemplates,
  } = options;

  // Determine dev mode: explicit option or fallback to NODE_ENV
  const isDevMode = devMode ?? (typeof process !== "undefined" && process.env?.NODE_ENV !== "production");

  return {
    name: "sibu-vite-plugin",
    enforce: "pre",

    config() {
      return {
        // Optimize dependency pre-bundling for sibu
        optimizeDeps: {
          include: ["sibu"],
        },
        // Ensure sibu is treated correctly for SSR
        ssr: {
          noExternal: ["sibu"],
        },
        // Define global constants for dead code elimination
        define: {
          __SIBU_DEV__: JSON.stringify(isDevMode),
          __SIBU_HMR__: JSON.stringify(hmr),
        },
        // Enable source maps in dev
        build: {
          sourcemap: isDevMode,
        },
      };
    },

    transform(code: string, id: string): { code: string; map?: unknown } | null {
      // Skip files that don't match include patterns or match exclude patterns
      if (!matchesPattern(id, include) || matchesPattern(id, exclude)) {
        return null;
      }

      let transformed = code;
      let modified = false;

      // Apply pure annotations for tree-shaking
      if (pureAnnotations) {
        const annotated = injectPureAnnotations(transformed);
        if (annotated !== transformed) {
          transformed = annotated;
          modified = true;
        }
      }

      // Inject dev helpers in dev mode
      if (isDevMode) {
        const withDevHelpers = injectDevHelpers(transformed);
        if (withDevHelpers !== transformed) {
          transformed = withDevHelpers;
          modified = true;
        }
      }

      // Compile html`` tagged templates to direct function calls (production only by default)
      const shouldCompile = compileTemplates ?? !isDevMode;
      if (shouldCompile && transformed.includes("html`")) {
        const compiled = compileHtmlTemplates(transformed);
        if (compiled.code) {
          // Add imports for used HTML tags
          const tagImports = Array.from(compiled.usedTags).filter((t) => !SVG_TAGS_SET.has(t));
          const needsSvg = compiled.usesSvg;
          const imports: string[] = [];
          if (tagImports.length > 0) {
            imports.push(`import { ${tagImports.join(", ")} } from "sibu";`);
          }
          if (needsSvg) {
            imports.push(`import { tagFactory as __sbTagFactory, SVG_NS as __sbSVG_NS } from "sibu";`);
          }
          // Only add imports that aren't already present
          const newImports = imports.filter((imp) => !transformed.includes(imp));
          if (newImports.length > 0) {
            compiled.code = `${newImports.join("\n")}\n${compiled.code}`;
          }
          transformed = compiled.code;
          modified = true;
        }
      }

      // Static template optimization (production only by default)
      const shouldOptimize = staticOptimize ?? !isDevMode;
      if (shouldOptimize) {
        const analysis = analyzeStaticTemplates(transformed);
        if (analysis.hasStaticPatterns) {
          // Replace from last to first to preserve indices
          const sorted = [...analysis.patterns].sort((a, b) => b.start - a.start);
          for (const pattern of sorted) {
            const replacement = `staticTemplate(${JSON.stringify(pattern.templateHtml)})`;
            transformed = transformed.slice(0, pattern.start) + replacement + transformed.slice(pattern.end);
          }
          // Ensure staticTemplate import exists
          if (!transformed.includes("import") || !transformed.includes("staticTemplate")) {
            transformed = `import { staticTemplate } from "sibu";\n${transformed}`;
          }
          modified = true;
        }
      }

      if (!modified) return null;

      return {
        code: transformed,
        map: undefined, // Let Vite handle source maps
      };
    },

    handleHotUpdate(ctx: { file: string; modules: unknown[] }) {
      if (!hmr) return;

      const { file } = ctx;

      // Check if the changed file is a SibuJS component
      if (matchesPattern(file, include) && !matchesPattern(file, exclude)) {
        // Log HMR update for SibuJS components in dev mode
        if (isDevMode) {
          console.log(`[sibu-vite-plugin] HMR update: ${file}`);
        }

        // Return the affected modules for Vite's HMR system to process
        // Vite will handle the actual module replacement
        return;
      }
    },
  };
}

/**
 * Generate an optimized Vite configuration for SibuJS projects.
 */
export function createViteConfig(
  options: {
    /** Entry point */
    entry?: string;
    /** Output directory */
    outDir?: string;
    /** Enable SSR mode */
    ssr?: boolean;
    /** Additional Vite config overrides */
    overrides?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const { entry = "src/main.ts", outDir = "dist", ssr = false, overrides = {} } = options;

  const baseConfig: Record<string, unknown> = {
    // Use the SibuJS Vite plugin
    plugins: [sibuVitePlugin()],

    // Build configuration
    build: {
      outDir,
      target: "es2020",
      minify: "esbuild",
      sourcemap: true,

      // Library mode configuration when building a library
      lib: ssr
        ? undefined
        : {
            entry,
            formats: ["es", "cjs"],
          },

      // Rollup-specific options
      rollupOptions: {
        input: ssr ? entry : undefined,
        output: {
          // Ensure consistent chunk naming
          chunkFileNames: "chunks/[name]-[hash].js",
          // Preserve pure annotations
          generatedCode: {
            constBindings: true,
          },
        },
        // Tree-shaking configuration
        treeshake: {
          moduleSideEffects: false,
          propertyReadSideEffects: false,
          annotations: true,
        },
      },
    },

    // Resolve configuration
    resolve: {
      // Prefer ESM versions of packages
      mainFields: ["module", "jsnext:main", "jsnext", "main"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".json"],
    },

    // SSR configuration
    ...(ssr
      ? {
          ssr: {
            noExternal: ["sibu"],
            target: "node",
          },
          build: {
            outDir,
            target: "node18",
            ssr: true,
            rollupOptions: {
              input: entry,
              output: {
                format: "esm",
              },
            },
          },
        }
      : {}),

    // Optimize dependency handling
    optimizeDeps: {
      include: ["sibu"],
      // Force pre-bundling of sibu for faster dev startup
      force: false,
    },

    // Environment variable handling
    define: {
      __SIBU_SSR__: JSON.stringify(ssr),
    },
  };

  // Deep merge overrides
  return deepMerge(baseConfig, overrides);
}

/**
 * Simple deep merge utility for configuration objects.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}
