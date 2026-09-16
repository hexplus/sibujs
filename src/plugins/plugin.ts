// ============================================================================
// PLUGIN ARCHITECTURE
// ============================================================================

import { DEV, devWarn } from "../core/dev";
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

/**
 * An installation that never took effect because `reset()` (or a newer install
 * of the same name) invalidated it. Thrown by a synchronous install that reset
 * its own registry, and the rejection of a cancelled async install — a
 * deliberate cancellation, not a failure, so it is not reported as a runtime
 * error.
 */
export class PluginInstallCancelledError extends Error {
  /** The plugin whose installation was cancelled. */
  readonly pluginName: string;

  constructor(pluginName: string) {
    super(`[Plugin] Installation of "${pluginName}" was cancelled before it was committed (registry reset).`);
    this.name = "PluginInstallCancelledError";
    this.pluginName = pluginName;
  }
}

export interface PluginRegistry {
  readonly installedPlugins: Set<string>;
  readonly hooks: PluginHooks;
  readonly provided: Map<string, unknown>;
  /**
   * Install a plugin. Returns a promise for an async `install()` — awaited, it
   * fulfils when the plugin is committed, rejects with the install failure, or
   * rejects with {@link PluginInstallCancelledError} when `reset()` invalidated
   * it; a synchronous install returns `undefined` and throws on failure.
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
  // Names whose `install()` is currently ON THE CALL STACK. A plugin that
  // installs itself — directly, or through a dependency that installs it back —
  // is rejected instead of recursing until the stack overflows. Deliberately
  // NOT cleared by reset(): the call is still on the stack, so a plugin that
  // resets the registry from inside its own install() cannot recurse.
  const installStack = new Set<string>();
  // Async installs that have not settled, with the generation each belongs to.
  // reset() drops them (their generation is gone), so the same name is free
  // again immediately.
  const pendingInstalls = new Map<string, number>();
  // Bumped by reset(): every context and every in-flight installation captures
  // the generation it belongs to, so a stale context cannot repopulate the
  // registry and a pending install cannot commit into a registry that has been
  // reset (or into a newer installation of the same name).
  let generation = 0;

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
      if (installStack.has(p.name)) {
        throw new Error(`[Plugin] "${p.name}" is already being installed (recursive installation).`);
      }
      if (pendingInstalls.has(p.name)) {
        throw new Error(`[Plugin] "${p.name}" is already being installed (asynchronous installation in flight).`);
      }

      const staged: PluginHooks = { init: [], mount: [], unmount: [], error: [] };
      const stagedProvided = new Map<string, unknown>();
      // Staging covers the whole installation — including the part after an
      // `await`. Once committed, `ctx` writes to the live registry again, so
      // hooks and providers registered later (from an init hook, a timer) are
      // not lost.
      let committed = false;
      const myGeneration = generation;
      const stale = (): boolean => {
        if (myGeneration === generation) return false;
        if (DEV) devWarn(`plugin: "${p.name}" registered after the registry was reset; the registration was ignored.`);
        return true;
      };
      const target = (): PluginHooks | null => (stale() ? null : committed ? hooks : staged);
      const ctx: PluginContext = {
        onInit: (cb) => void target()?.init.push(cb),
        onMount: (cb) => void target()?.mount.push(cb),
        onUnmount: (cb) => void target()?.unmount.push(cb),
        onError: (cb) => void target()?.error.push(cb),
        provide: (key, value) => {
          if (stale()) return;
          (committed ? provided : stagedProvided).set(key, value);
        },
      };

      /** Commits the staged registrations; false when this install was cancelled. */
      const commit = (): boolean => {
        // The registry was reset (or re-used for this name) while the install
        // was in flight: this installation no longer owns anything here.
        if (myGeneration !== generation) return false;
        hooks.init.push(...staged.init);
        hooks.mount.push(...staged.mount);
        hooks.unmount.push(...staged.unmount);
        hooks.error.push(...staged.error);
        for (const [key, value] of stagedProvided) provided.set(key, value);
        installedPlugins.add(p.name);
        committed = true;
        if (pendingInstalls.get(p.name) === myGeneration) pendingInstalls.delete(p.name);

        // Run only this plugin's init hooks registered during install(), from a
        // snapshot (an init hook registering another does not run it now).
        for (const cb of staged.init.slice()) {
          try {
            cb();
          } catch (e) {
            console.error(`[Plugin] "${p.name}" init error:`, e);
          }
        }
        return true;
      };

      installStack.add(p.name);
      let pending: Promise<unknown> | null;
      try {
        // adoptThenable reads `then` once and turns a throwing getter or
        // invocation into a rejection.
        pending = adoptThenable(p.install(ctx, options));
      } finally {
        // The call has left the stack, whatever it did (including resetting the
        // registry); a later install of this name is a new transaction.
        installStack.delete(p.name);
      }

      if (!pending) {
        // A synchronous install that reset the registry committed nothing, and
        // must not look like it succeeded.
        if (!commit()) throw new PluginInstallCancelledError(p.name);
        return;
      }

      // Async install: the name is reserved until the promise settles, so a
      // concurrent attempt is refused. Only fulfilment commits.
      pendingInstalls.set(p.name, myGeneration);
      const settled = pending.then(
        () => {
          if (!commit()) throw new PluginInstallCancelledError(p.name);
        },
        (err) => {
          // Only release the reservation when it is still this installation's:
          // a reset (or a newer install of the same name) owns it now.
          if (pendingInstalls.get(p.name) === myGeneration) pendingInstalls.delete(p.name);
          reportError(err, { phase: "async", name: `plugin(${p.name})` });
          throw err;
        },
      );
      // Handled here so a caller that ignores the returned promise gets a
      // reported error (or a silent cancellation) rather than an unhandled
      // rejection; the promise this returns still rejects for an awaiting caller.
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
      // Terminal for everything issued before it: in-flight installs cannot
      // commit, and contexts handed to already-installed plugins stop writing.
      generation++;
      // In-flight async installs belong to the old generation: they can neither
      // commit nor keep their name reserved. `installStack` is NOT cleared —
      // those calls are still running, and the recursion guard must hold.
      pendingInstalls.clear();
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
 *
 * Returns the installation's completion promise when `install()` is async —
 * await it to know the plugin is ready, or to catch a failed installation — and
 * `undefined` for a synchronous install (which throws on failure).
 */
export function plugin(plugin: SibuPlugin, options?: unknown): void | Promise<void> {
  _defaults.touched = true;
  // Returned, not discarded: an async install's completion (and failure) has to
  // reach the caller through the singleton API too.
  return _defaults.registry.plugin(plugin, options);
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
