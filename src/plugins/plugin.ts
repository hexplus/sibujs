// ============================================================================
// PLUGIN ARCHITECTURE
// ============================================================================

import { reportError } from "../core/errors";
import { adoptThenable } from "../utils/adoptThenable";
import { globalSingleton } from "../utils/globalSingleton";

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
  /**
   * Register hooks and providers. May be async: the plugin is committed only
   * when the returned promise fulfils, and a rejection commits nothing and
   * leaves the plugin installable again.
   */
  install: (ctx: PluginContext, options?: unknown) => void | PromiseLike<void>;
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
  /**
   * Install a plugin. Returns a promise for an async `install()` — awaited, it
   * settles when the plugin is committed (or rejects with the install failure);
   * a synchronous install returns `undefined` and throws on failure.
   */
  plugin: (p: SibuPlugin, options?: unknown) => void | Promise<void>;
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
  // Names whose `install()` is currently on the stack. A plugin that installs
  // itself — directly, or through a dependency that installs it back — is
  // rejected instead of recursing until the stack overflows.
  const installing = new Set<string>();

  const registry: PluginRegistry = {
    installedPlugins,
    hooks,
    provided,
    /**
     * Install a plugin as a transaction.
     *
     * Hooks and providers registered through `ctx` are staged and committed
     * only if `install()` returns; a throwing install leaves the registry
     * exactly as it found it (and can simply be retried). The plugin is marked
     * installed at commit, before its init hooks run.
     *
     * Each `plugin()` call is its own transaction: a dependency installed by a
     * nested `plugin()` call commits on its own and stays installed even if the
     * outer installation later fails.
     */
    plugin(p, options) {
      if (installedPlugins.has(p.name)) {
        console.warn(`[Plugin] "${p.name}" is already installed.`);
        return;
      }
      if (installing.has(p.name)) {
        throw new Error(`[Plugin] "${p.name}" is already being installed (recursive installation).`);
      }

      const staged: PluginHooks = { init: [], mount: [], unmount: [], error: [] };
      const stagedProvided = new Map<string, unknown>();
      // Staging covers the whole installation — including the part after an
      // `await`. Once committed, `ctx` writes to the live registry again, so
      // hooks and providers registered later (from an init hook, a timer) are
      // not lost.
      let committed = false;
      const target = () => (committed ? hooks : staged);
      const ctx: PluginContext = {
        onInit: (cb) => target().init.push(cb),
        onMount: (cb) => target().mount.push(cb),
        onUnmount: (cb) => target().unmount.push(cb),
        onError: (cb) => target().error.push(cb),
        provide: (key, value) => (committed ? provided : stagedProvided).set(key, value),
      };

      const commit = (): void => {
        hooks.init.push(...staged.init);
        hooks.mount.push(...staged.mount);
        hooks.unmount.push(...staged.unmount);
        hooks.error.push(...staged.error);
        for (const [key, value] of stagedProvided) provided.set(key, value);
        installedPlugins.add(p.name);
        committed = true;
        installing.delete(p.name);

        // Run only this plugin's init hooks registered during install(), from a
        // snapshot (an init hook registering another does not run it now).
        for (const cb of staged.init.slice()) {
          try {
            cb();
          } catch (e) {
            console.error(`[Plugin] "${p.name}" init error:`, e);
          }
        }
      };

      installing.add(p.name);
      let pending: Promise<unknown> | null;
      try {
        // adoptThenable reads `then` once and turns a throwing getter or
        // invocation into a rejection.
        pending = adoptThenable(p.install(ctx, options));
      } catch (err) {
        // Synchronous failure: nothing is committed and the name is free again.
        installing.delete(p.name);
        throw err;
      }

      if (!pending) {
        commit();
        return;
      }

      // Async install: the name stays in `installing` (so a concurrent attempt
      // is rejected) until the promise settles. Only fulfilment commits.
      const settled = pending.then(
        () => commit(),
        (err) => {
          installing.delete(p.name);
          reportError(err, { phase: "async", name: `plugin(${p.name})` });
          throw err;
        },
      );
      // Handled here so a caller that ignores the returned promise gets a
      // reported error rather than an unhandled rejection; the promise this
      // returns still rejects for a caller that awaits it.
      settled.catch(() => {});
      return settled;
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
// Shared across duplicate module copies so plugins installed through one copy
// are visible to `inject()` called through another.
const _defaults = globalSingleton(Symbol.for("sibujs.plugins.defaultRegistry.v1"), () => ({
  registry: createPluginRegistry(),
  touched: false,
}));

/**
 * Creates a plugin definition.
 */
export function createPlugin(
  name: string,
  install: (ctx: PluginContext, options?: unknown) => void | PromiseLike<void>,
): SibuPlugin {
  return { name, install };
}

/**
 * Installs a plugin into the default (singleton) registry.
 */
export function plugin(plugin: SibuPlugin, options?: unknown): void {
  _defaults.touched = true;
  _defaults.registry.plugin(plugin, options);
}

/**
 * Retrieve a value provided by a plugin (from the default registry).
 */
export function inject<T = unknown>(key: string, defaultValue?: T): T {
  return _defaults.registry.inject<T>(key, defaultValue);
}

/**
 * Trigger mount hooks for an element (default registry).
 */
export function triggerPluginMount(element: HTMLElement): void {
  _defaults.registry.triggerMount(element);
}

/**
 * Trigger unmount hooks for an element (default registry).
 */
export function triggerPluginUnmount(element: HTMLElement): void {
  _defaults.registry.triggerUnmount(element);
}

/**
 * Trigger error hooks (default registry).
 */
export function triggerPluginError(error: Error): void {
  _defaults.registry.triggerError(error);
}

/**
 * Reset the default plugin registry (useful for testing).
 */
export function resetPlugins(): void {
  _defaults.registry.reset();
  _defaults.touched = false;
}

/**
 * Replace the default registry with an isolated one. Emits a dev warning
 * if the default singleton already had plugins installed (to surface
 * accidental interleaving of singleton + registry use).
 */
export function setDefaultPluginRegistry(registry: PluginRegistry): void {
  if (_defaults.touched && _defaults.registry.installedPlugins.size > 0) {
    console.warn(
      "[Plugin] Replacing default plugin registry while plugins are already installed on the singleton. " +
        "This may indicate mixed singleton/registry usage.",
    );
  }
  _defaults.registry = registry;
  _defaults.touched = true;
}
