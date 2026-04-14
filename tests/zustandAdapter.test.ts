import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZustandAdapterAPI } from "../src/ecosystem/adapters/zustand";
import { type ZustandStore, zustandAdapter } from "../src/ecosystem/adapters/zustand";
import { inject, plugin, resetPlugins } from "../src/plugins/plugin";

interface TestState {
  bears: number;
  fish: number;
}

function createMockZustandStore(
  initialState: TestState,
): ZustandStore<TestState> & { _trigger: (s: TestState) => void } {
  let state = { ...initialState };
  const listeners = new Set<(state: TestState, prev: TestState) => void>();
  return {
    getState: () => state,
    setState: vi.fn((partial, _replace?) => {
      const prev = state;
      if (typeof partial === "function") {
        state = { ...state, ...partial(state) };
      } else {
        state = { ...state, ...partial };
      }
      for (const l of listeners) l(state, prev);
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy: vi.fn(),
    _trigger: (s: TestState) => {
      const prev = state;
      state = s;
      for (const l of listeners) l(state, prev);
    },
  };
}

describe("zustandAdapter", () => {
  beforeEach(() => {
    resetPlugins();
  });

  it("should install plugin and provide API", () => {
    const store = createMockZustandStore({ bears: 0, fish: 10 });
    plugin(zustandAdapter({ store }));
    const api = inject<ZustandAdapterAPI<TestState>>("zustand");
    expect(api).toBeDefined();
    expect(api.getState).toBeTypeOf("function");
    expect(api.select).toBeTypeOf("function");
  });

  it("should return initial state", () => {
    const store = createMockZustandStore({ bears: 5, fish: 3 });
    plugin(zustandAdapter({ store }));
    const api = inject<ZustandAdapterAPI<TestState>>("zustand");
    expect(api.getState().bears).toBe(5);
  });

  it("should create reactive selector", () => {
    const store = createMockZustandStore({ bears: 0, fish: 10 });
    plugin(zustandAdapter({ store }));
    const api = inject<ZustandAdapterAPI<TestState>>("zustand");
    const bears = api.select((s) => s.bears);
    expect(bears()).toBe(0);

    store._trigger({ bears: 7, fish: 10 });
    expect(bears()).toBe(7);
  });

  it("should proxy setState to Zustand store", () => {
    const store = createMockZustandStore({ bears: 0, fish: 0 });
    plugin(zustandAdapter({ store }));
    const api = inject<ZustandAdapterAPI<TestState>>("zustand");

    api.setState({ bears: 3 });
    expect(store.setState).toHaveBeenCalledWith({ bears: 3 });
  });

  it("should call store.destroy on destroy", () => {
    const store = createMockZustandStore({ bears: 0, fish: 0 });
    plugin(zustandAdapter({ store }));
    const api = inject<ZustandAdapterAPI<TestState>>("zustand");

    api.destroy();
    expect(store.destroy).toHaveBeenCalled();
  });
});
