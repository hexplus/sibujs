// ============================================================================
// PLUGIN ARCHITECTURE
// ============================================================================

export interface PluginContext {
  /** Register a global hook */
  onInit: (callback: () => void) => void;
  onMount: (callback: (element: HTMLElement) => void) => void;
  onUnmount: (callback: (element: HTMLElement) => void) => void;
  onError: (callback: (error: Error) => void) => void;
  /** Provide a value globally */
  provide: (key: string, value: unknown) => void;
}

export interface SibuPlugin {
  name: string;
  install: (ctx: PluginContext, options?: unknown) => void;
}

interface PluginHooks {
  init: Array<() => void>;
  mount: Array<(element: HTMLElement) => void>;
  unmount: Array<(element: HTMLElement) => void>;
  error: Array<(error: Error) => void>;
}

export interface PluginRegistry {
  readonly installedPlugins: Set<string>;
  readonly hooks: PluginHooks;
  readonly provided: Map<string, unknown>;
  plugin: (p: SibuPlugin, options?: unknown) => void;
  inject: <T = unknown>(key: string, defaultValue?: T) => T;
  triggerMount: (element: HTMLElement) => void;
  triggerUnmount: (element: HTMLElement) => void;
  triggerError: (error: Error) => void;
  reset: () => void;
}

/**
 * Create an isolated plugin registry. Useful for tests, SSR per-request
 * isolation, or embedding multiple independent SibuJS apps on one page.
 */
export function createPluginRegistry(): PluginRegistry {
  const installedPlugins = new Set<string>();
  const hooks: PluginHooks = { init: [], mount: [], unmount: [], error: [] };
  const provided = new Map<string, unknown>();

  const registry: PluginRegistry = {
    installedPlugins,
    hooks,
    provided,
    plugin(p, options) {
      if (installedPlugins.has(p.name)) {
        console.warn(`[Plugin] "${p.name}" is already installed.`);
        return;
      }
      const ctx: PluginContext = {
        onInit: (cb) => hooks.init.push(cb),
        onMount: (cb) => hooks.mount.push(cb),
        onUnmount: (cb) => hooks.unmount.push(cb),
        onError: (cb) => hooks.error.push(cb),
        provide: (key, value) => provided.set(key, value),
      };
      const initHooksBefore = hooks.init.length;
      p.install(ctx, options);
      installedPlugins.add(p.name);
      // Snapshot only the init hooks added by this plugin, then iterate the copy
      const justAdded = hooks.init.slice(initHooksBefore);
      for (const cb of justAdded) {
        try {
          cb();
        } catch (e) {
          console.error(`[Plugin] "${p.name}" init error:`, e);
        }
      }
    },
    inject<T = unknown>(key: string, defaultValue?: T): T {
      if (provided.has(key)) return provided.get(key) as T;
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`[Plugin] No provider found for key "${key}"`);
    },
    triggerMount(element) {
      // Snapshot before iterating — hooks may register/unregister re-entrantly
      const snapshot = hooks.mount.slice();
      for (const hook of snapshot) {
        try {
          hook(element);
        } catch (e) {
          console.error("[Plugin] Mount hook error:", e);
        }
      }
    },
    triggerUnmount(element) {
      const snapshot = hooks.unmount.slice();
      for (const hook of snapshot) {
        try {
          hook(element);
        } catch (e) {
          console.error("[Plugin] Unmount hook error:", e);
        }
      }
    },
    triggerError(error) {
      const snapshot = hooks.error.slice();
      for (const hook of snapshot) {
        try {
          hook(error);
        } catch (e) {
          console.error("[Plugin] Error hook error:", e);
        }
      }
    },
    reset() {
      installedPlugins.clear();
      hooks.init.length = 0;
      hooks.mount.length = 0;
      hooks.unmount.length = 0;
      hooks.error.length = 0;
      provided.clear();
    },
  };
  return registry;
}

// Default singleton registry (kept for back-compat with existing public API).
let defaultRegistry: PluginRegistry = createPluginRegistry();
let defaultRegistryTouched = false;

/**
 * Creates a plugin definition.
 */
export function createPlugin(name: string, install: (ctx: PluginContext, options?: unknown) => void): SibuPlugin {
  return { name, install };
}

/**
 * Installs a plugin into the default (singleton) registry.
 */
export function plugin(plugin: SibuPlugin, options?: unknown): void {
  defaultRegistryTouched = true;
  defaultRegistry.plugin(plugin, options);
}

/**
 * Retrieve a value provided by a plugin (from the default registry).
 */
export function inject<T = unknown>(key: string, defaultValue?: T): T {
  return defaultRegistry.inject<T>(key, defaultValue);
}

/**
 * Trigger mount hooks for an element (default registry).
 */
export function triggerPluginMount(element: HTMLElement): void {
  defaultRegistry.triggerMount(element);
}

/**
 * Trigger unmount hooks for an element (default registry).
 */
export function triggerPluginUnmount(element: HTMLElement): void {
  defaultRegistry.triggerUnmount(element);
}

/**
 * Trigger error hooks (default registry).
 */
export function triggerPluginError(error: Error): void {
  defaultRegistry.triggerError(error);
}

/**
 * Reset the default plugin registry (useful for testing).
 */
export function resetPlugins(): void {
  defaultRegistry.reset();
  defaultRegistryTouched = false;
}

/**
 * Replace the default registry with an isolated one. Emits a dev warning
 * if the default singleton already had plugins installed (to surface
 * accidental interleaving of singleton + registry use).
 */
export function setDefaultPluginRegistry(registry: PluginRegistry): void {
  if (defaultRegistryTouched && defaultRegistry.installedPlugins.size > 0) {
    console.warn(
      "[Plugin] Replacing default plugin registry while plugins are already installed on the singleton. " +
        "This may indicate mixed singleton/registry usage.",
    );
  }
  defaultRegistry = registry;
  defaultRegistryTouched = true;
}
