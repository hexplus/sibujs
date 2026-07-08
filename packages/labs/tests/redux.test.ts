import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReduxAdapterAPI, ReduxStore } from "../src/ecosystem/adapters/redux";
import { reduxAdapter } from "../src/ecosystem/adapters/redux";
import { inject, plugin, resetPlugins } from "sibujs/plugins";

interface CounterState {
  counter: number;
  label: string;
}

/**
 * Hand-rolled fake Redux store matching the minimal ReduxStore shape.
 * Redux is not installed; the adapter only relies on getState/dispatch/subscribe.
 */
function createFakeReduxStore(initial: CounterState): ReduxStore<CounterState> & {
  listeners: Array<() => void>;
  setStateDirect: (next: CounterState) => void;
} {
  let state = initial;
  const listeners: Array<() => void> = [];

  return {
    listeners,
    getState() {
      return state;
    },
    dispatch(action: unknown) {
      const a = action as { type: string };
      if (a.type === "increment") {
        state = { ...state, counter: state.counter + 1 };
      } else if (a.type === "setLabel") {
        state = { ...state, label: (action as { label: string }).label };
      }
      for (const l of listeners.slice()) l();
      return action;
    },
    subscribe(listener: () => void) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    setStateDirect(next: CounterState) {
      state = next;
      for (const l of listeners.slice()) l();
    },
  };
}

describe("reduxAdapter", () => {
  beforeEach(() => {
    resetPlugins();
  });

  it("installs the plugin and provides a 'redux' API", () => {
    const store = createFakeReduxStore({ counter: 0, label: "x" });
    plugin(reduxAdapter({ store }));
    const api = inject<ReduxAdapterAPI<CounterState>>("redux");
    expect(api).toBeDefined();
    expect(api.getState).toBeTypeOf("function");
    expect(api.select).toBeTypeOf("function");
    expect(api.dispatch).toBeTypeOf("function");
    expect(api.destroy).toBeTypeOf("function");
  });

  it("subscribes to the store on install", () => {
    const store = createFakeReduxStore({ counter: 0, label: "x" });
    plugin(reduxAdapter({ store }));
    expect(store.listeners.length).toBe(1);
  });

  it("exposes the initial store state via getState()", () => {
    const store = createFakeReduxStore({ counter: 7, label: "init" });
    plugin(reduxAdapter({ store }));
    const api = inject<ReduxAdapterAPI<CounterState>>("redux");
    expect(api.getState()).toEqual({ counter: 7, label: "init" });
  });

  it("updates the reactive getState() when the store changes", () => {
    const store = createFakeReduxStore({ counter: 0, label: "x" });
    plugin(reduxAdapter({ store }));
    const api = inject<ReduxAdapterAPI<CounterState>>("redux");

    api.dispatch({ type: "increment" });
    expect(api.getState().counter).toBe(1);

    api.dispatch({ type: "increment" });
    expect(api.getState().counter).toBe(2);
  });

  it("select() returns a reactive getter scoped to a slice", () => {
    const store = createFakeReduxStore({ counter: 5, label: "x" });
    plugin(reduxAdapter({ store }));
    const api = inject<ReduxAdapterAPI<CounterState>>("redux");

    const count = api.select((s) => s.counter);
    expect(count()).toBe(5);

    api.dispatch({ type: "increment" });
    expect(count()).toBe(6);
  });

  it("select() getters reflect independent slices", () => {
    const store = createFakeReduxStore({ counter: 0, label: "hello" });
    plugin(reduxAdapter({ store }));
    const api = inject<ReduxAdapterAPI<CounterState>>("redux");

    const label = api.select((s) => s.label);
    expect(label()).toBe("hello");

    api.dispatch({ type: "setLabel", label: "world" });
    expect(label()).toBe("world");
  });

  it("dispatch() forwards the action to the underlying store and returns it", () => {
    const store = createFakeReduxStore({ counter: 0, label: "x" });
    const dispatchSpy = vi.spyOn(store, "dispatch");
    plugin(reduxAdapter({ store }));
    const api = inject<ReduxAdapterAPI<CounterState>>("redux");

    const action = { type: "increment" };
    const result = api.dispatch(action);
    expect(dispatchSpy).toHaveBeenCalledWith(action);
    expect(result).toBe(action);
  });

  it("destroy() unsubscribes from the store", () => {
    const store = createFakeReduxStore({ counter: 0, label: "x" });
    plugin(reduxAdapter({ store }));
    const api = inject<ReduxAdapterAPI<CounterState>>("redux");

    expect(store.listeners.length).toBe(1);
    api.destroy();
    expect(store.listeners.length).toBe(0);
  });

  it("stops reacting to store changes after destroy()", () => {
    const store = createFakeReduxStore({ counter: 0, label: "x" });
    plugin(reduxAdapter({ store }));
    const api = inject<ReduxAdapterAPI<CounterState>>("redux");
    const count = api.select((s) => s.counter);

    api.destroy();
    // Mutate directly via the store; the adapter is no longer subscribed.
    store.setStateDirect({ counter: 99, label: "x" });
    expect(count()).toBe(0);
  });
});
