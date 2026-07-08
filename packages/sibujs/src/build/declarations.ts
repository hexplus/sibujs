/**
 * TypeScript declaration map utilities for SibuJS.
 * Provides tsconfig helpers and declaration generation support
 * for improved IDE experience and type-safe development.
 */

/**
 * Recommended TypeScript compiler options for SibuJS projects.
 */
const RECOMMENDED_OPTIONS: Record<string, unknown> = {
  target: "ES2020",
  module: "ESNext",
  moduleResolution: "bundler",
  strict: true,
  esModuleInterop: true,
  skipLibCheck: true,
  declaration: true,
  declarationMap: true,
  sourceMap: true,
  jsx: "preserve",
  lib: ["ES2020", "DOM", "DOM.Iterable"],
  isolatedModules: true,
  resolveJsonModule: true,
  allowSyntheticDefaultImports: true,
  forceConsistentCasingInFileNames: true,
  noUncheckedIndexedAccess: true,
  noEmit: false,
};

/**
 * Required compiler options for SibuJS compatibility.
 * These settings must be present for the framework to work correctly.
 */
const REQUIRED_OPTIONS: Record<string, { value: unknown; reason: string }> = {
  strict: {
    value: true,
    reason: "SibuJS relies on strict type checking for safe reactive state handling.",
  },
  esModuleInterop: {
    value: true,
    reason: "Required for correct ESM interop with SibuJS module exports.",
  },
  moduleResolution: {
    value: ["node", "bundler", "node16", "nodenext"],
    reason: "SibuJS requires a module resolution strategy that supports package.json exports.",
  },
};

/**
 * Suggested compiler options that improve the SibuJS development experience.
 */
const SUGGESTED_OPTIONS: Record<string, { value: unknown; reason: string }> = {
  declarationMap: {
    value: true,
    reason: 'Enables "Go to Definition" to navigate to SibuJS source files in your IDE.',
  },
  sourceMap: {
    value: true,
    reason: "Enables source map debugging for SibuJS components.",
  },
  noUncheckedIndexedAccess: {
    value: true,
    reason: "Improves type safety when accessing reactive state objects.",
  },
  isolatedModules: {
    value: true,
    reason: "Required for compatibility with esbuild/swc transpilers used by Vite.",
  },
};

/**
 * Generate a recommended tsconfig.json for SibuJS projects.
 *
 * @param options - Customization options for the generated configuration
 * @returns A complete tsconfig.json object
 *
 * @example
 * ```ts
 * import { generateTsConfig } from 'sibu/src/build/declarations';
 * import { writeFileSync } from 'fs';
 *
 * const config = generateTsConfig({ outDir: './dist' });
 * writeFileSync('tsconfig.json', JSON.stringify(config, null, 2));
 * ```
 */
export function generateTsConfig(options?: {
  /** TypeScript compilation target (default: 'ES2020') */
  target?: string;
  /** Output directory for compiled files */
  outDir?: string;
  /** Enable declaration map generation (default: true) */
  declarationMap?: boolean;
  /** Additional path aliases */
  paths?: Record<string, string[]>;
}): Record<string, unknown> {
  const { target = "ES2020", outDir = "dist", declarationMap = true, paths } = options || {};

  const compilerOptions: Record<string, unknown> = {
    ...RECOMMENDED_OPTIONS,
    target,
    outDir,
    declarationMap,
  };

  // Add path aliases if provided
  if (paths && Object.keys(paths).length > 0) {
    compilerOptions.baseUrl = ".";
    compilerOptions.paths = {
      // Default sibu alias
      sibu: ["node_modules/sibu/dist/index.d.ts"],
      "sibu/*": ["node_modules/sibu/dist/*"],
      // User-provided paths
      ...paths,
    };
  }

  return {
    compilerOptions,
    include: ["src/**/*.ts", "src/**/*.tsx"],
    exclude: ["node_modules", "dist", "**/*.test.ts", "**/*.spec.ts"],
  };
}

/**
 * Validate that a project's TypeScript configuration is compatible with SibuJS.
 *
 * Checks for required settings, warns about suboptimal configurations,
 * and suggests improvements for the best development experience.
 *
 * @param config - The tsconfig.json object to validate (the full config, including compilerOptions)
 * @returns Validation result with warnings and suggestions
 *
 * @example
 * ```ts
 * import { validateTsConfig } from 'sibu/src/build/declarations';
 * import { readFileSync } from 'fs';
 *
 * const tsconfig = JSON.parse(readFileSync('tsconfig.json', 'utf-8'));
 * const result = validateTsConfig(tsconfig);
 *
 * if (!result.valid) {
 *   console.error('TypeScript configuration issues:', result.warnings);
 * }
 * result.suggestions.forEach(s => console.log('Suggestion:', s));
 * ```
 */
export function validateTsConfig(config: Record<string, unknown>): {
  valid: boolean;
  warnings: string[];
  suggestions: string[];
} {
  const warnings: string[] = [];
  const suggestions: string[] = [];

  const compilerOptions = (config.compilerOptions || {}) as Record<string, unknown>;

  // Check required options
  for (const [option, requirement] of Object.entries(REQUIRED_OPTIONS)) {
    const currentValue = compilerOptions[option];

    if (Array.isArray(requirement.value)) {
      // Option must be one of the allowed values
      if (currentValue === undefined) {
        warnings.push(
          `Missing required option "${option}". ${requirement.reason} ` +
            `Recommended value: one of ${requirement.value.map((v: unknown) => `"${v}"`).join(", ")}.`,
        );
      } else if (!(requirement.value as unknown[]).includes(currentValue)) {
        warnings.push(
          `Option "${option}" is set to "${currentValue}" which may not be compatible with SibuJS. ` +
            `${requirement.reason} Recommended: one of ${requirement.value.map((v: unknown) => `"${v}"`).join(", ")}.`,
        );
      }
    } else {
      // Option must match exact value
      if (currentValue === undefined) {
        warnings.push(
          `Missing required option "${option}". ${requirement.reason} ` +
            `Recommended value: ${JSON.stringify(requirement.value)}.`,
        );
      } else if (currentValue !== requirement.value) {
        warnings.push(
          `Option "${option}" is set to ${JSON.stringify(currentValue)} but SibuJS recommends ` +
            `${JSON.stringify(requirement.value)}. ${requirement.reason}`,
        );
      }
    }
  }

  // Check suggested options
  for (const [option, suggestion] of Object.entries(SUGGESTED_OPTIONS)) {
    const currentValue = compilerOptions[option];

    if (currentValue === undefined || currentValue !== suggestion.value) {
      suggestions.push(`Consider setting "${option}" to ${JSON.stringify(suggestion.value)}. ${suggestion.reason}`);
    }
  }

  // Check target compatibility
  const target = typeof compilerOptions.target === "string" ? compilerOptions.target.toUpperCase() : undefined;
  if (target) {
    const es2020Plus = ["ES2020", "ES2021", "ES2022", "ES2023", "ES2024", "ESNEXT"];
    if (!es2020Plus.includes(target)) {
      warnings.push(
        `Target "${target}" may not support all features used by SibuJS. ` +
          `Recommended: "ES2020" or newer. SibuJS uses optional chaining, ` +
          "nullish coalescing, and other ES2020+ features.",
      );
    }
  }

  // Check module system
  const module = typeof compilerOptions.module === "string" ? compilerOptions.module.toLowerCase() : undefined;
  if (module && !["esnext", "es2020", "es2022", "node16", "nodenext"].includes(module)) {
    suggestions.push(
      `Module "${compilerOptions.module}" may not provide optimal results with SibuJS. ` +
        `Consider using "ESNext" for best tree-shaking and bundle optimization.`,
    );
  }

  // Check lib includes DOM
  const lib = compilerOptions.lib;
  if (Array.isArray(lib)) {
    const hasDom = lib.some((l: string) => l.toUpperCase() === "DOM" || l.toUpperCase() === "DOM.ITERABLE");
    if (!hasDom) {
      suggestions.push(
        'The "lib" array does not include "DOM". SibuJS requires DOM types ' +
          'for component rendering. Add "DOM" and "DOM.Iterable" to your lib array.',
      );
    }
  }

  // Check include patterns
  if (Array.isArray(config.include)) {
    const includesTs = (config.include as string[]).some(
      (pattern: string) => pattern.includes(".ts") || pattern.includes("*"),
    );
    if (!includesTs) {
      suggestions.push(
        'Your "include" patterns may not capture TypeScript files. ' +
          'Ensure patterns like "src/**/*.ts" are included.',
      );
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
    suggestions,
  };
}
