/**
 * Official Vite plugin for SibuJS.
 * Provides optimized builds, automatic component detection, and development enhancements.
 */

import {
  applyEdits,
  editsSourceMap,
  jsStringLiteral,
  lineBreaksIn,
  normalizeEdits,
  type SourceEdit,
  type SourceMapV3,
} from "./sourceEdit";
import { importsSibu, pureAnnotationEdits, scanModule, uniquePrefix } from "./sourceScan";
import { analyzeStaticTemplates } from "./staticAnalysis";
import { planHtmlTemplates } from "./templateCompiler";

export interface SibuVitePluginOptions {
  /** Enable HMR support for SibuJS components */
  hmr?: boolean;
  /**
   * Annotate calls to side-effect-free sibujs factories (`tagFactory`,
   * `context`, ...) as pure for tree-shaking. Only direct calls to names
   * imported from sibujs are annotated. Default: true.
   */
  pureAnnotations?: boolean;
  /** Component file patterns to watch */
  include?: string[];
  /** File patterns to exclude */
  exclude?: string[];
  /**
   * Enable dev mode features (devtools, debug logging). When omitted it is
   * derived from Vite's own command/mode (`vite build` is production unless
   * `--mode development`; `vite serve` is development), falling back to
   * `NODE_ENV` only when the plugin is driven outside Vite.
   */
  devMode?: boolean;
  /**
   * Replace provably static tag-factory calls (`div({ class: "x" }, "text")`)
   * with `staticTemplate(...)` markup. Default: **false**, in every mode.
   *
   * Off by default because it is not a win: `staticTemplate` parses its markup
   * on every call, which is slower than the tag factory's `createElement` +
   * `setAttribute` for the single-element calls that can be proven static, and
   * the proof has to exclude every prop the factory treats specially (URL and
   * style sanitizing, IDL-only booleans, event and ref props). The analysis is
   * conservative and correct, but a correct pessimization is not a sane
   * default. It previously defaulted to on and rewrote non-sibujs calls
   * (`db.select({...})`) and the template compiler's output into invalid code.
   */
  staticOptimize?: boolean;
  /**
   * Compile `html` tagged templates (imported from sibujs) to direct DOM
   * construction. Default: true in production builds. A template the compiler
   * cannot reproduce exactly is left to the runtime parser.
   */
  compileTemplates?: boolean;
}

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
 * The development prologue, as an edit that adds no line.
 *
 * Plain JavaScript on purpose: the plugin runs with `enforce: "pre"`, so for a
 * `.js`/`.jsx` file this text reaches the JavaScript parser as-is. It used to
 * be a TypeScript cast, which is a syntax error in every JavaScript module.
 *
 * It shares the module's first line (after a hashbang, which must stay first)
 * instead of adding lines of its own: two prepended lines shifted every stack
 * trace and breakpoint of every sibujs module in development.
 */
function devPrologueEdit(code: string): SourceEdit | null {
  let at = 0;
  if (code.startsWith("#!")) {
    const nl = code.indexOf("\n");
    if (nl === -1) return null;
    at = nl + 1;
  }
  return {
    start: at,
    end: at,
    text: '/* SibuJS Dev Mode */ if (typeof globalThis !== "undefined") { globalThis.__SIBU_DEV__ = true; } ',
  };
}

/**
 * Replace provably static tag-factory calls with `staticTemplate` markup.
 *
 * `staticTemplate` lives in `sibujs/performance` — it is not exported from the
 * package root — and it is imported under a collision-proof alias appended to
 * the module, so neither an existing `staticTemplate` import nor a local of
 * that name can clash. (The old guard, `!includes("import") ||
 * !includes("staticTemplate")`, was false for any file that had an import, so
 * the import was never added and the bundle threw a ReferenceError.)
 *
 * The parsed element is adopted into `document`, making it indistinguishable
 * from a factory-built one: detached and owned by the page's document rather
 * than a child of the template's inert fragment.
 *
 * The analysis runs on the ORIGINAL source, like every other step: compiled
 * templates contain no tag-factory calls, and a call inside a template
 * expression is rewritten in place either way. The alias prefix is derived
 * from the same source as the template compiler's; the two use disjoint
 * names under it (`static`/`staticTemplate` vs `t0`/`attr`/...).
 */
function staticOptimizationEdits(code: string): { edits: SourceEdit[]; append: string } | null {
  const analysis = analyzeStaticTemplates(code);
  if (!analysis.hasStaticPatterns) return null;
  const P = uniquePrefix(code);
  const edits = analysis.patterns.map((pattern) => ({
    start: pattern.start,
    end: pattern.end,
    // A call spanning several lines keeps its line breaks.
    text: `${P}static(${jsStringLiteral(pattern.templateHtml)}${lineBreaksIn(code, pattern.start, pattern.end)})`,
  }));
  const append =
    `\nimport { staticTemplate as ${P}staticTemplate } from "sibujs/performance";\n` +
    `function ${P}static(markup) {\n  return document.adoptNode(${P}staticTemplate(markup));\n}\n`;
  return { edits, append };
}

/** The subset of Vite's config environment / resolved config the plugin reads. */
interface ViteModeInfo {
  command?: string;
  mode?: string;
}

/**
 * Resolve dev mode. An explicit option always wins; otherwise Vite's own
 * command/mode decides. Deciding from `NODE_ENV` at plugin creation was wrong
 * for the most common setup — the variable is usually unset while
 * `vite.config.ts` is evaluated, so `vite build` produced a development build.
 */
function resolveDevMode(explicit: boolean | undefined, info: ViteModeInfo | undefined): boolean {
  if (explicit !== undefined) return explicit;
  if (info?.command === "build") return info.mode === "development";
  if (info?.command === "serve") return true;
  return typeof process !== "undefined" && process.env?.NODE_ENV !== "production";
}

/**
 * Vite plugin configuration for SibuJS projects.
 * Returns a Vite-compatible plugin object.
 */
export function sibuVitePlugin(options: SibuVitePluginOptions = {}): {
  name: string;
  enforce?: "pre" | "post";
  config?: (userConfig?: unknown, env?: ViteModeInfo) => Record<string, unknown>;
  configResolved?: (config: ViteModeInfo) => void;
  transform?: (code: string, id: string) => { code: string; map: SourceMapV3 } | null;
  handleHotUpdate?: (ctx: { file: string; modules: unknown[] }) => void;
} {
  const {
    hmr = true,
    pureAnnotations = true,
    include = DEFAULT_INCLUDE,
    exclude = DEFAULT_EXCLUDE,
    devMode,
    staticOptimize = false,
    compileTemplates,
  } = options;

  // Provisional until Vite reports its command/mode through `config` /
  // `configResolved`; used as-is when the plugin is driven outside Vite.
  let isDevMode = resolveDevMode(devMode, undefined);

  return {
    name: "sibu-vite-plugin",
    enforce: "pre",

    config(_userConfig?: unknown, env?: ViteModeInfo) {
      isDevMode = resolveDevMode(devMode, env);
      return {
        // Optimize dependency pre-bundling for sibujs
        optimizeDeps: {
          include: ["sibujs"],
        },
        // Ensure sibujs is treated correctly for SSR
        ssr: {
          noExternal: ["sibujs"],
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

    configResolved(config: ViteModeInfo) {
      isDevMode = resolveDevMode(devMode, config);
    },

    transform(code: string, id: string): { code: string; map: SourceMapV3 } | null {
      // Skip files that don't match include patterns or match exclude patterns
      if (!matchesPattern(id, include) || matchesPattern(id, exclude)) {
        return null;
      }
      // Every step below only acts on modules that import from sibujs.
      if (!code.includes("sibujs")) return null;
      // One scan of the module, shared by every step (memoized per source).
      // A module that cannot be scanned with confidence is left untouched.
      if (!scanModule(code)) return null;

      // Every step describes its change as edits against the ORIGINAL source;
      // they are applied together, and the source map is generated from the
      // same list. No step adds or removes a line of the original code.
      const edits: SourceEdit[] = [];
      let append = "";

      // Dev helpers in dev mode (first, so the flag is set before module code).
      if (isDevMode && importsSibu(code)) {
        const prologue = devPrologueEdit(code);
        if (prologue) edits.push(prologue);
      }

      // Pure annotations for tree-shaking.
      if (pureAnnotations) {
        edits.push(...pureAnnotationEdits(code));
      }

      // Compile html`` tagged templates (production only by default). The
      // injected imports are aliased (`Fragment as __sibujs$Fragment`, ...),
      // so they can never duplicate or collide with the file's own imports or
      // locals.
      const shouldCompile = compileTemplates ?? !isDevMode;
      if (shouldCompile) {
        const plan = planHtmlTemplates(code);
        if (plan.compiledCount > 0) {
          edits.push(...plan.edits);
          append += plan.append;
        }
      }

      // Static template optimization (opt-in; see the option's docs).
      if (staticOptimize) {
        const optimized = staticOptimizationEdits(code);
        if (optimized) {
          edits.push(...optimized.edits);
          append += optimized.append;
        }
      }

      if (edits.length === 0 && append === "") return null;
      // The steps never touch overlapping ranges; if they ever did, leaving
      // the module alone is the only safe answer.
      const sorted = normalizeEdits(edits);
      if (!sorted) return null;
      const transformed = applyEdits(code, sorted, append);
      if (transformed === code) return null;

      return {
        code: transformed,
        map: editsSourceMap(code, sorted, append, id),
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
            noExternal: ["sibujs"],
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
      include: ["sibujs"],
      // Force pre-bundling of sibujs for faster dev startup
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
