import { derived } from "../../core/signals/derived";
import { signal } from "../../core/signals/signal";
import { createPlugin, type SibuPlugin } from "../../plugins/plugin";
import { batch } from "../../reactivity/batch";

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
      return derived(() => selector(getState()));
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
