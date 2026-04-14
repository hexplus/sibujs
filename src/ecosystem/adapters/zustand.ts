import { derived } from "../../core/signals/derived";
import { signal } from "../../core/signals/signal";
import { createPlugin, type SibuPlugin } from "../../plugins/plugin";
import { batch } from "../../reactivity/batch";

/** Minimal Zustand store interface (peer dependency). */
export interface ZustandStore<S> {
  getState(): S;
  setState(partial: Partial<S> | ((state: S) => Partial<S>), replace?: boolean): void;
  subscribe(listener: (state: S, prevState: S) => void): () => void;
  destroy(): void;
}

export interface ZustandAdapterOptions<S> {
  store: ZustandStore<S>;
}

export interface ZustandAdapterAPI<S> {
  /** Full Zustand state as a SibuJS reactive getter */
  getState: () => S;
  /** Create a SibuJS reactive getter from a Zustand selector */
  select: <R>(selector: (state: S) => R) => () => R;
  /** Set state on the Zustand store */
  setState: ZustandStore<S>["setState"];
  /** Destroy the subscription and the Zustand store */
  destroy: () => void;
}

/**
 * Creates a Zustand adapter plugin for SibuJS.
 *
 * @example
 * ```ts
 * import { zustandAdapter } from "sibu/extras";
 * import { createStore } from "zustand/vanilla";
 *
 * const bearStore = createStore((set) => ({
 *   bears: 0,
 *   increase: () => set((s) => ({ bears: s.bears + 1 })),
 * }));
 *
 * const plugin = zustandAdapter({ store: bearStore });
 * plugin(plugin);
 *
 * const zs = inject<ZustandAdapterAPI>("zustand");
 * const bears = zs.select(s => s.bears);
 * div(() => `Bears: ${bears()}`);
 * ```
 */
export function zustandAdapter<S>(options: ZustandAdapterOptions<S>): SibuPlugin {
  return createPlugin("sibu-zustand", (ctx) => {
    const { store } = options;
    const [getState, setSibuState] = signal<S>(store.getState());

    const unsubscribe = store.subscribe((state) => {
      batch(() => {
        setSibuState(state);
      });
    });

    function select<R>(selector: (state: S) => R): () => R {
      return derived(() => selector(getState()));
    }

    const api: ZustandAdapterAPI<S> = {
      getState,
      select,
      setState: store.setState.bind(store),
      destroy() {
        unsubscribe();
        store.destroy();
      },
    };

    ctx.provide("zustand", api);
  });
}
