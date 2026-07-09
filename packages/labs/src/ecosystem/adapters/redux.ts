import { batch, signal } from "@sibujs/core";
import { createPlugin, type SibuPlugin } from "sibujs/plugins";

/** Minimal Redux store interface (peer dependency — no import from redux). */
export interface ReduxStore<S = unknown> {
  getState(): S;
  dispatch(action: unknown): unknown;
  subscribe(listener: () => void): () => void;
}

export interface ReduxAdapterOptions<S = unknown> {
  store: ReduxStore<S>;
}

export interface ReduxAdapterAPI<S = unknown> {
  /** Full store state as a SibuJS reactive getter */
  getState: () => S;
  /** Create a SibuJS reactive getter from a Redux selector */
  select: <R>(selector: (state: S) => R) => () => R;
  /** Dispatch an action to the Redux store */
  dispatch: ReduxStore<S>["dispatch"];
  /** Unsubscribe from the Redux store */
  destroy: () => void;
}

/**
 * Creates a Redux adapter plugin for SibuJS.
 *
 * Bridges Redux store subscriptions into SibuJS signal-based reactivity.
 * Each selector becomes a reactive getter that auto-updates when Redux
 * state changes.
 *
 * @example
 * ```ts
 * import { reduxAdapter } from "sibu/extras";
 * import { createStore } from "redux";
 *
 * const reduxStore = createStore(rootReducer);
 * const reduxPlugin = reduxAdapter({ store: reduxStore });
 * plugin(reduxPlugin);
 *
 * const redux = inject<ReduxAdapterAPI>("redux");
 * const count = redux.select(s => s.counter);
 * div(() => `Count: ${count()}`);
 * ```
 */
export function reduxAdapter<S>(options: ReduxAdapterOptions<S>): SibuPlugin {
  return createPlugin("sibu-redux", (ctx) => {
    const { store } = options;
    const [getState, setState] = signal<S>(store.getState());

    const unsubscribe = store.subscribe(() => {
      batch(() => {
        setState(store.getState());
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

    const api: ReduxAdapterAPI<S> = {
      getState,
      select,
      dispatch: store.dispatch.bind(store),
      destroy: unsubscribe,
    };

    ctx.provide("redux", api);
  });
}
