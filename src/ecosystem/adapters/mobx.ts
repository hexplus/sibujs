import { effect } from "../../core/signals/effect";
import { signal } from "../../core/signals/signal";
import { createPlugin, type SibuPlugin } from "../../plugins/plugin";
import { batch } from "../../reactivity/batch";

/** MobX autorun disposer function type. */
export type MobXReactionDisposer = () => void;

export interface MobXAdapterOptions {
  /** MobX's autorun function — passed to avoid importing MobX directly. */
  autorun: (view: () => void) => MobXReactionDisposer;
}

export interface MobXAdapterAPI {
  /**
   * Bridge a MobX observable into a SibuJS reactive getter.
   *
   * Takes a MobX expression (function reading MobX observables)
   * and returns a SibuJS getter that updates when the observables change.
   */
  fromMobX: <T>(expression: () => T) => (() => T) & { dispose: () => void };

  /**
   * Bridge a SibuJS getter into a MobX reaction.
   *
   * Runs a callback whenever a SibuJS signal changes.
   */
  toMobX: (sibuGetter: () => unknown, callback: (value: unknown) => void) => () => void;

  /** Dispose all active bridges. */
  destroy: () => void;
}

/**
 * Creates a MobX adapter plugin for SibuJS.
 *
 * Unlike Redux/Zustand, MobX has distributed observables rather than
 * a single store. The adapter provides `fromMobX()` to bridge any
 * MobX expression into a SibuJS reactive getter.
 *
 * @example
 * ```ts
 * import { mobXAdapter } from "sibu/extras";
 * import { autorun, makeAutoObservable } from "mobx";
 *
 * class TodoStore {
 *   todos: string[] = [];
 *   constructor() { makeAutoObservable(this); }
 *   addTodo(t: string) { this.todos.push(t); }
 * }
 *
 * const todoStore = new TodoStore();
 * const plugin = mobXAdapter({ autorun });
 * plugin(plugin);
 *
 * const mobx = inject<MobXAdapterAPI>("mobx");
 * const todoCount = mobx.fromMobX(() => todoStore.todos.length);
 * div(() => `Todos: ${todoCount()}`);
 * ```
 */
export function mobXAdapter(options: MobXAdapterOptions): SibuPlugin {
  return createPlugin("sibu-mobx", (ctx) => {
    const { autorun } = options;
    const disposers: MobXReactionDisposer[] = [];

    function fromMobX<T>(expression: () => T): (() => T) & { dispose: () => void } {
      // Seed with `undefined` and let autorun's synchronous first invocation
      // populate the signal — autorun calls the view immediately, so calling
      // expression() here as well would double-evaluate observables.
      const [getValue, setValue] = signal<T | undefined>(undefined);

      const disposer = autorun(() => {
        const newValue = expression();
        batch(() => {
          setValue(newValue as T);
        });
      });
      disposers.push(disposer);

      // Attach a per-subscription dispose on the getter so callers can
      // unsubscribe individually without tearing down the whole adapter.
      const getter = (() => getValue() as T) as (() => T) & { dispose: () => void };
      getter.dispose = () => {
        const i = disposers.indexOf(disposer);
        if (i >= 0) disposers.splice(i, 1);
        disposer();
      };
      return getter;
    }

    function toMobX(sibuGetter: () => unknown, callback: (value: unknown) => void): () => void {
      return effect(() => {
        callback(sibuGetter());
      });
    }

    function destroy(): void {
      for (const disposer of disposers) {
        disposer();
      }
      disposers.length = 0;
    }

    const api: MobXAdapterAPI = { fromMobX, toMobX, destroy };
    ctx.provide("mobx", api);
  });
}
