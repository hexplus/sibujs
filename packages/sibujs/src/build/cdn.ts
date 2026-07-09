/**
 * CDN distribution utilities for SibuJS.
 * Supports UMD builds for script tag usage and CDN delivery.
 */

// Re-import all major exports for global registration
import * as SibuExports from "../../index";

/**
 * The package name used in CDN URLs and UMD builds.
 */
const PACKAGE_NAME = "sibujs";

/**
 * Register SibuJS on the global window object for CDN/script tag usage.
 * Makes all exports available as window.Sibu.
 *
 * Usage (in a script tag):
 * ```html
 * <script src="https://unpkg.com/sibujs@latest/dist/cdn.global.js"></script>
 * <script>
 *   const { div, span, mount, signal } = window.Sibu;
 *   // Use SibuJS without a bundler
 * </script>
 * ```
 */
export function registerGlobal(): void {
  if (typeof window === "undefined") return;

  (window as unknown as Record<string, unknown>).Sibu = { ...SibuExports };
}

/**
 * Generate a UMD (Universal Module Definition) wrapper for a SibuJS module.
 * The wrapper supports AMD (RequireJS), CommonJS (Node.js), and browser globals.
 *
 * @param name - The global variable name for browser usage
 * @param factory - Factory function that returns the module's exports
 * @returns The UMD wrapper code as a string
 */
export function umdWrapper(name: string, factory: () => unknown): string {
  // Serialize the factory for embedding in the wrapper
  const factoryStr = factory.toString();

  return `(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    // AMD (RequireJS)
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    // CommonJS (Node.js)
    module.exports = factory();
  } else {
    // Browser globals
    root.${name} = factory();
  }
}(typeof self !== 'undefined' ? self : this, ${factoryStr}));`;
}

/**
 * CDN URL helpers for common CDN providers.
 * Generates URLs for including SibuJS from popular CDN services.
 */
export const cdnUrls = {
  /**
   * Generate an unpkg CDN URL.
   * @param version - Package version (defaults to 'latest')
   */
  unpkg: (version?: string): string => `https://unpkg.com/${PACKAGE_NAME}@${version || "latest"}/dist/cdn.global.js`,

  /**
   * Generate a jsDelivr CDN URL.
   * @param version - Package version (defaults to 'latest')
   */
  jsdelivr: (version?: string): string =>
    `https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${version || "latest"}/dist/cdn.global.js`,

  /**
   * Generate a Skypack CDN URL (ESM-native).
   * @param version - Package version (defaults to 'latest')
   */
  skypack: (version?: string): string => `https://cdn.skypack.dev/${PACKAGE_NAME}@${version || "latest"}`,

  /**
   * Generate a complete HTML script tag for including SibuJS from a CDN.
   *
   * @param provider - CDN provider to use (defaults to 'jsdelivr')
   * @param version - Package version (defaults to 'latest')
   * @returns An HTML script tag string
   *
   * @example
   * ```ts
   * cdnUrls.scriptTag('jsdelivr', '4.0.0-alpha.0')
   * // => '<script src="https://cdn.jsdelivr.net/npm/sibujs@4.0.0-alpha.0/dist/cdn.global.js"></script>'
   * ```
   */
  scriptTag: (provider: "unpkg" | "jsdelivr" | "skypack" = "jsdelivr", version?: string): string => {
    const url = cdnUrls[provider](version);

    // Skypack serves ESM, so use type="module"
    if (provider === "skypack") {
      return `<script type="module">\nimport * as Sibu from '${url}';\nwindow.Sibu = Sibu;\n</script>`;
    }

    return `<script src="${url}"></script>`;
  },
};

/**
 * Generate an import map for SibuJS modules.
 * Useful for browser-native ES modules without a bundler.
 *
 * Import maps allow browsers to resolve bare module specifiers like
 * `import { div } from 'sibujs'` without a build step.
 *
 * @param baseUrl - Base URL for module resolution (defaults to jsDelivr)
 * @returns An import map object with serialization helpers
 *
 * @example
 * ```ts
 * const map = generateImportMap();
 * document.head.innerHTML += map.toScriptTag();
 *
 * // Now you can use bare specifiers in module scripts:
 * // <script type="module">
 * //   import { div, mount } from 'sibujs';
 * // </script>
 * ```
 */
export function generateImportMap(baseUrl?: string): {
  imports: Record<string, string>;
  toJSON: () => string;
  toScriptTag: () => string;
} {
  const base = baseUrl || `https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@latest`;

  const imports: Record<string, string> = {
    // Main package entry
    [PACKAGE_NAME]: `${base}/dist/index.js`,
    // Sub-path imports matching the package's published exports map.
    [`${PACKAGE_NAME}/data`]: `${base}/dist/data.js`,
    [`${PACKAGE_NAME}/ui`]: `${base}/dist/ui.js`,
    [`${PACKAGE_NAME}/ssr`]: `${base}/dist/ssr.js`,
    [`${PACKAGE_NAME}/plugins`]: `${base}/dist/plugins.js`,
    [`${PACKAGE_NAME}/build`]: `${base}/dist/build.js`,
    [`${PACKAGE_NAME}/testing`]: `${base}/dist/testing.js`,
  };

  return {
    imports,

    /**
     * Serialize the import map to a JSON string.
     */
    toJSON(): string {
      return JSON.stringify({ imports }, null, 2);
    },

    /**
     * Generate a complete `<script type="importmap">` tag.
     */
    toScriptTag(): string {
      return `<script type="importmap">\n${JSON.stringify({ imports }, null, 2)}\n</script>`;
    },
  };
}
