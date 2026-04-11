/**
 * Bundle size analysis utilities for SibuJS.
 * Provides tools to analyze, estimate, and report on bundle sizes
 * for SibuJS projects.
 */

/**
 * Known approximate sizes (in bytes, minified + gzipped) for SibuJS modules.
 * These estimates are based on the typical compiled output of each module
 * and are useful for pre-build size budgeting.
 */
export const moduleSizes: Record<string, number> = {
  // Core modules
  "core/html": 1800,
  "core/mount": 120,
  "core/each": 450,
  "core/slots": 200,
  "core/fragment": 180,
  "core/catch": 280,
  "core/portal": 350,
  "core/directives": 520,
  "core/dynamic": 380,
  "core/head": 300,
  "core/ssr": 1200,
  "core/customElement": 650,
  "core/scopedStyle": 480,
  "core/domRecycler": 420,
  "core/bundleOptimize": 200,
  "core/compiled": 350,
  "core/normalize": 280,
  "core/reactiveAttr": 320,
  "core/componentProps": 400,
  "core/contracts": 350,
  "core/worker": 550,
  "core/wasm": 480,
  "core/concurrent": 600,
  "core/microfrontend": 700,
  "core/chunkLoader": 450,
  "core/versioning": 300,
  "core/ecosystem": 250,

  // Signals
  "core/signal": 280,
  "core/effect": 350,
  "core/derived": 250,
  "core/watch": 300,
  "core/store": 380,
  "core/ref": 150,
  "core/array": 420,
  "core/deepSignal": 500,
  "core/lifecycle": 300,
  "core/context": 350,
  "core/persist": 400,
  "core/hoc": 280,
  "core/transition": 600,
  "core/form": 750,
  "core/globalStore": 450,
  "core/machine": 550,
  "core/optimistic": 380,
  "core/timeTravel": 500,
  "core/scheduler": 350,
  "core/plugin": 300,
  "core/virtualList": 800,
  "core/intersection": 350,
  "core/inputMask": 450,
  "core/a11y": 500,
  "core/debug": 400,
  "core/serviceWorker": 350,
  "core/composable": 280,

  // Reactivity
  "reactivity/signal": 100,
  "reactivity/track": 250,
  "reactivity/batch": 200,
  "reactivity/bindAttribute": 300,
  "reactivity/bindChildNode": 250,
  "reactivity/bindTextNode": 200,

  // Components
  "components/ErrorBoundary": 350,
  "components/Loading": 250,

  // Plugins
  "plugins/i18n": 600,
  "plugins/router": 900,
  "plugins/routerSSR": 500,

  // Build utilities
  "build/vite": 800,
  "build/webpack": 750,
  "build/cdn": 400,
  "build/declarations": 500,
  "build/analyzer": 600,

  // Testing
  "testing/index": 700,
  "testing/e2e": 500,
};

/**
 * Format a byte count as a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Analyze module sizes and dependencies.
 *
 * Takes a record of module names to their source code and computes
 * size statistics for each module and the total bundle.
 *
 * @param modules - A map of module names to their source code strings
 * @returns Analysis results with sizes, sorted rankings, and a report generator
 *
 * @example
 * ```ts
 * import { analyzeBundle } from 'sibu/src/build/analyzer';
 *
 * const result = analyzeBundle({
 *   'app.ts': appSourceCode,
 *   'components/Header.ts': headerSourceCode,
 *   'components/Footer.ts': footerSourceCode,
 * });
 *
 * console.log(result.report());
 * // Total: 12.5 KB
 * // app.ts: 8.2 KB (65.6%)
 * // components/Header.ts: 2.8 KB (22.4%)
 * // components/Footer.ts: 1.5 KB (12.0%)
 * ```
 */
export function analyzeBundle(modules: Record<string, string>): {
  /** Total bundle size in bytes */
  totalSize: number;
  /** Size per module in bytes */
  moduleSizes: Record<string, number>;
  /** Modules sorted by size (largest first) */
  sorted: Array<{ name: string; size: number; percentage: number }>;
  /** Format as human-readable report */
  report: () => string;
} {
  const sizes: Record<string, number> = {};
  let totalSize = 0;

  // Calculate size for each module using byte length of the source
  for (const [name, source] of Object.entries(modules)) {
    // Use TextEncoder for accurate byte length if available, otherwise approximate
    let byteLength: number;
    if (typeof TextEncoder !== "undefined") {
      byteLength = new TextEncoder().encode(source).length;
    } else {
      // Fallback: count characters (approximate for ASCII-heavy code)
      byteLength = source.length;
    }
    sizes[name] = byteLength;
    totalSize += byteLength;
  }

  // Sort modules by size (largest first)
  const sorted = Object.entries(sizes)
    .map(([name, size]) => ({
      name,
      size,
      percentage: totalSize > 0 ? (size / totalSize) * 100 : 0,
    }))
    .sort((a, b) => b.size - a.size);

  return {
    totalSize,
    moduleSizes: sizes,
    sorted,

    report(): string {
      const lines: string[] = [
        "=== SibuJS Bundle Analysis ===",
        "",
        `Total size: ${formatBytes(totalSize)}`,
        `Modules: ${sorted.length}`,
        "",
        "Module breakdown:",
        "-".repeat(60),
      ];

      for (const entry of sorted) {
        const sizeStr = formatBytes(entry.size).padStart(10);
        const pctStr = `${entry.percentage.toFixed(1)}%`.padStart(6);
        const bar = generateBar(entry.percentage, 20);
        lines.push(`  ${sizeStr}  ${pctStr}  ${bar}  ${entry.name}`);
      }

      lines.push("-".repeat(60));
      return lines.join("\n");
    },
  };
}

/**
 * Generate a simple ASCII bar for visual representation.
 */
function generateBar(percentage: number, width: number): string {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  return `[${"#".repeat(filled)}${".".repeat(empty)}]`;
}

/**
 * Estimate the impact of importing specific SibuJS modules.
 * Based on known approximate sizes of each module (minified + gzipped).
 *
 * This is useful for understanding the cost of specific imports
 * before building, enabling informed decisions about which features to use.
 *
 * @param imports - Array of module paths to estimate (e.g., ['core/signal', 'core/html'])
 * @returns Estimated size information with breakdown
 *
 * @example
 * ```ts
 * import { estimateImportSize } from 'sibu/src/build/analyzer';
 *
 * // Estimate cost of a minimal SibuJS app
 * const estimate = estimateImportSize([
 *   'core/html',
 *   'core/mount',
 *   'core/signal',
 *   'core/effect',
 *   'reactivity/track',
 *   'reactivity/batch',
 * ]);
 *
 * console.log(estimate.formatted);
 * // Estimated bundle size: 3.17 KB (minified + gzipped)
 * //   core/html: 1.76 KB
 * //   core/effect: 0.34 KB
 * //   ...
 * ```
 */
export function estimateImportSize(imports: string[]): {
  /** Total estimated size in bytes */
  estimated: number;
  /** Size breakdown per module */
  breakdown: Record<string, number>;
  /** Human-readable formatted output */
  formatted: string;
} {
  const breakdown: Record<string, number> = {};
  let estimated = 0;

  // Always include core reactivity as implicit dependencies
  const implicitDeps = ["reactivity/signal", "reactivity/track"];
  const allImports = [...new Set([...implicitDeps, ...imports])];

  for (const importPath of allImports) {
    const size = moduleSizes[importPath];
    if (size !== undefined) {
      breakdown[importPath] = size;
      estimated += size;
    } else {
      // Unknown module: estimate based on average module size
      const avgSize = 350;
      breakdown[importPath] = avgSize;
      estimated += avgSize;
    }
  }

  // Sort breakdown by size for the formatted output
  const sortedEntries = Object.entries(breakdown).sort(([, a], [, b]) => b - a);

  const lines: string[] = [`Estimated bundle size: ${formatBytes(estimated)} (minified + gzipped)`, ""];

  for (const [modulePath, size] of sortedEntries) {
    const known = moduleSizes[modulePath] !== undefined;
    lines.push(`  ${modulePath}: ${formatBytes(size)}${known ? "" : " (estimated)"}`);
  }

  if (imports.length > 0) {
    lines.push("");
    lines.push("Note: Actual sizes may vary based on tree-shaking and build configuration.");
    lines.push("Implicit dependencies (reactivity/signal, reactivity/track) are included.");
  }

  return {
    estimated,
    breakdown,
    formatted: lines.join("\n"),
  };
}
