import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReduxAdapterAPI } from "../src/ecosystem/adapters/redux";
import { reduxAdapter } from "../src/ecosystem/adapters/redux";
import { inject, plugin, resetPlugins } from "../src/plugins/plugin";

interface TestState {
  count: number;
  name: string;
}

function createMockReduxStore(initialState: TestState) {
  let state = { ...initialState };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: vi.fn((action: { type: string; payload: unknown }) => {
      if (action.type === "SET_COUNT") state = { ...state, count: action.payload };
      if (action.type === "SET_NAME") state = { ...state, name: action.payload };
      for (const l of listeners) l();
      return action;
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    _setState: (s: TestState) => {
      state = s;
      for (const l of listeners) l();
    },
  };
}

describe("reduxAdapter", () => {
  beforeEach(() => {
    resetPlugins();
  });

  it("should install plugin and provide API via inject", () => {
    const store = createMockReduxStore({ count: 0, name: "Alice" });
    const p = reduxAdapter({ store });
    plugin(p);
    const api = inject<ReduxAdapterAPI<TestState>>("redux");
    expect(api).toBeDefined();
    expect(api.getState).toBeTypeOf("function");
    expect(api.select).toBeTypeOf("function");
    expect(api.dispatch).toBeTypeOf("function");
    expect(api.destroy).toBeTypeOf("function");
  });

  it("should return initial state via getState", () => {
    const store = createMockReduxStore({ count: 5, name: "Bob" });
    const p = reduxAdapter({ store });
    plugin(p);
    const api = inject<ReduxAdapterAPI<TestState>>("redux");
    expect(api.getState().count).toBe(5);
    expect(api.getState().name).toBe("Bob");
  });

  it("should create reactive selector via select", () => {
    const store = createMockReduxStore({ count: 10, name: "Carol" });
    const p = reduxAdapter({ store });
    plugin(p);
    const api = inject<ReduxAdapterAPI<TestState>>("redux");
    const count = api.select((s) => s.count);
    expect(count()).toBe(10);
  });

  it("should update selector when store changes", () => {
    const store = createMockReduxStore({ count: 0, name: "Dave" });
    const p = reduxAdapter({ store });
    plugin(p);
    const api = inject<ReduxAdapterAPI<TestState>>("redux");
    const count = api.select((s) => s.count);
    expect(count()).toBe(0);

    store.dispatch({ type: "SET_COUNT", payload: 42 });
    expect(count()).toBe(42);
  });

  it("should proxy dispatch to the Redux store", () => {
    const store = createMockReduxStore({ count: 0, name: "Eve" });
    const p = reduxAdapter({ store });
    plugin(p);
    const api = inject<ReduxAdapterAPI<TestState>>("redux");

    api.dispatch({ type: "SET_NAME", payload: "Frank" });
    expect(store.dispatch).toHaveBeenCalledWith({ type: "SET_NAME", payload: "Frank" });
  });

  it("should stop updating after destroy", () => {
    const store = createMockReduxStore({ count: 0, name: "Grace" });
    const p = reduxAdapter({ store });
    plugin(p);
    const api = inject<ReduxAdapterAPI<TestState>>("redux");
    const count = api.select((s) => s.count);

    api.destroy();
    store._setState({ count: 999, name: "Grace" });
    // After destroy, the SibuJS signal should not update
    expect(count()).toBe(0);
  });
});
