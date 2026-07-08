// ============================================================================
// ECOSYSTEM INTEGRATION
// ============================================================================

/**
 * Ecosystem integration utilities for SibuJS.
 * Provides adapters for common testing frameworks, bundlers, and CI/CD pipelines.
 */

// ─── Testing Framework Adapters ─────────────────────────────────────────────

/**
 * Create a test harness for SibuJS components.
 * Works with any testing framework (Vitest, Jest, Mocha).
 */
export function createTestHarness() {
  let container: HTMLElement;

  return {
    /** Set up a clean DOM container before each test */
    setup(): HTMLElement {
      container = document.createElement("div");
      container.setAttribute("data-sibu-test", "true");
      document.body.appendChild(container);
      return container;
    },

    /** Tear down the DOM container after each test */
    teardown(): void {
      if (container?.parentNode) {
        container.parentNode.removeChild(container);
      }
    },

    /** Render a component into the test container */
    render(component: (() => HTMLElement) | HTMLElement): HTMLElement {
      const el = typeof component === "function" ? component() : component;
      container.appendChild(el);
      return el;
    },

    /** Get the test container */
    getContainer(): HTMLElement {
      return container;
    },

    /** Wait for reactive updates to settle */
    async flush(): Promise<void> {
      // Flush microtasks
      await new Promise<void>((r) => setTimeout(r, 0));
      // Wait for any pending animation frame callbacks
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    },

    /** Query within the container */
    query(selector: string): Element | null {
      return container.querySelector(selector);
    },

    /** Query all matching elements within the container */
    queryAll(selector: string): Element[] {
      return Array.from(container.querySelectorAll(selector));
    },

    /** Simulate a click event */
    click(el: Element): void {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    },

    /** Simulate input value change */
    input(el: HTMLInputElement, value: string): void {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
  };
}

// ─── Bundler Integration ────────────────────────────────────────────────────

/**
 * Metadata for bundler plugins to consume.
 * Provides information about SibuJS module structure for tree-shaking optimization.
 */
export const bundlerMetadata = {
  name: "sibu" as const,
  sideEffects: false as const,
  modules: {
    core: ["html", "mount", "each", "slots", "fragment", "catch", "portal", "directives"],
    hooks: ["signal", "effect", "derived", "watch", "store", "ref", "array", "deepSignal"],
    plugins: ["router", "i18n"],
    components: ["ErrorBoundary", "Loading"],
    ssr: ["ssr"],
    advanced: ["globalStore", "machine", "optimistic", "timeTravel", "scheduler", "plugin"],
  } as Record<string, string[]>,

  /** Generate import map for module resolution */
  generateImportMap(base: string = "/node_modules/sibu/"): Record<string, string> {
    const map: Record<string, string> = {};
    for (const [category, modules] of Object.entries(this.modules)) {
      for (const mod of modules) {
        // Hooks live in src/core/, everything else lives under its own category directory
        const dir = category === "hooks" ? "core" : category;
        map[`sibu/${mod}`] = `${base}src/${dir}/${mod}.js`;
      }
    }
    return map;
  },
};

// ─── CI/CD Integration ──────────────────────────────────────────────────────

/**
 * Health check utility for CI/CD pipelines.
 * Verifies that the framework is properly installed and configured.
 */
export function healthCheck(): {
  status: "ok" | "warning" | "error";
  checks: Array<{ name: string; passed: boolean; message: string }>;
} {
  const checks: Array<{ name: string; passed: boolean; message: string }> = [];

  // Check DOM availability
  const hasDOM = typeof document !== "undefined";
  checks.push({
    name: "DOM Environment",
    passed: hasDOM,
    message: hasDOM ? "DOM is available" : "No DOM environment (SSR mode)",
  });

  // Check requestAnimationFrame
  const hasRAF = typeof requestAnimationFrame !== "undefined";
  checks.push({
    name: "requestAnimationFrame",
    passed: hasRAF,
    message: hasRAF ? "Available" : "Not available (polyfill may be needed)",
  });

  // Check MutationObserver
  const hasMO = typeof MutationObserver !== "undefined";
  checks.push({
    name: "MutationObserver",
    passed: hasMO,
    message: hasMO ? "Available" : "Not available (lifecycle hooks may not work)",
  });

  const allPassed = checks.every((c) => c.passed);
  return {
    status: allPassed ? "ok" : "warning",
    checks,
  };
}

// ─── Environment Detection ──────────────────────────────────────────────────

/**
 * Environment detection utilities.
 */
export const env = {
  /** True when running in a browser with a DOM */
  isBrowser: typeof window !== "undefined" && typeof document !== "undefined",

  /** True when running in Node.js */
  isNode: typeof process !== "undefined" && !!process.versions?.node,

  /** True when running inside a Web Worker */
  isWorker:
    typeof self !== "undefined" && typeof (self as unknown as Record<string, unknown>).importScripts === "function",

  /** True when running inside Deno */
  isDeno: typeof (globalThis as unknown as Record<string, unknown>).Deno !== "undefined",

  /** True when running inside Bun */
  isBun: typeof (globalThis as unknown as Record<string, unknown>).Bun !== "undefined",

  /** True when no window object is available (server-side rendering) */
  isSSR: typeof window === "undefined",

  /** True when NODE_ENV is not "production" */
  isDev: typeof process !== "undefined" && process.env?.NODE_ENV !== "production",

  /** True when NODE_ENV is "test" or VITEST is set */
  isTest: typeof process !== "undefined" && (process.env?.NODE_ENV === "test" || process.env?.VITEST === "true"),
};
