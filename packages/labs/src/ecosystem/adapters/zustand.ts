import { batch, signal } from "@sibujs/core";
import { createPlugin, type SibuPlugin } from "sibujs/plugins";

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
      // Return a plain reactive getter, not a standalone derived(): a derived
      // performs an eager initial track(), permanently subscribing to the
      // adapter's app-lifetime getState signal, which leaks when select() is
      // called per-component. Reading getState() inside the CALLER's own
      // effect/derived ties the subscription to the caller's lifecycle instead,
      // and stays fully reactive.
      return () => selector(getState());
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
