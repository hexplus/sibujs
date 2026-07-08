import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZustandAdapterAPI, ZustandStore } from "../src/ecosystem/adapters/zustand";
import { zustandAdapter } from "../src/ecosystem/adapters/zustand";
import { inject, plugin, resetPlugins } from "sibujs/plugins";

interface BearState {
  bears: number;
  honey: number;
}

/**
 * Hand-rolled fake Zustand vanilla store matching the minimal ZustandStore shape.
 * Zustand is not installed; the adapter only uses getState/setState/subscribe/destroy.
 * The subscribe listener receives (state, prevState) like Zustand's vanilla store.
 */
function createFakeZustandStore(initial: BearState): ZustandStore<BearState> & {
  listeners: Array<(state: BearState, prev: BearState) => void>;
  destroyed: boolean;
} {
  let state = initial;
  const listeners: Array<(state: BearState, prev: BearState) => void> = [];
  const store = {
    listeners,
    destroyed: false,
    getState() {
      return state;
    },
    setState(partial: Partial<BearState> | ((s: BearState) => Partial<BearState>)) {
      const prev = state;
      const patch = typeof partial === "function" ? partial(state) : partial;
      state = { ...state, ...patch };
      for (const l of listeners.slice()) l(state, prev);
    },
    subscribe(listener: (state: BearState, prev: BearState) => void) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    destroy() {
      store.destroyed = true;
      listeners.length = 0;
    },
  };
  return store;
}

describe("zustandAdapter", () => {
  beforeEach(() => {
    resetPlugins();
  });

  it("installs the plugin and provides a 'zustand' API", () => {
    const store = createFakeZustandStore({ bears: 0, honey: 0 });
    plugin(zustandAdapter({ store }));
    const api = inject<ZustandAdapterAPI<BearState>>("zustand");
    expect(api).toBeDefined();
    expect(api.getState).toBeTypeOf("function");
    expect(api.select).toBeTypeOf("function");
    expect(api.setState).toBeTypeOf("function");
    expect(api.destroy).toBeTypeOf("function");
  });

  it("subscribes to the store on install", () => {
    const store = createFakeZustandStore({ bears: 0, honey: 0 });
    plugin(zustandAdapter({ store }));
    expect(store.listeners.length).toBe(1);
  });

  it("exposes the initial state via getState()", () => {
    const store = createFakeZustandStore({ bears: 3, honey: 9 });
    plugin(zustandAdapter({ store }));
    const api = inject<ZustandAdapterAPI<BearState>>("zustand");
    expect(api.getState()).toEqual({ bears: 3, honey: 9 });
  });

  it("updates getState() reactively when the store changes", () => {
    const store = createFakeZustandStore({ bears: 0, honey: 0 });
    plugin(zustandAdapter({ store }));
    const api = inject<ZustandAdapterAPI<BearState>>("zustand");

    api.setState({ bears: 5 });
    expect(api.getState().bears).toBe(5);
  });

  it("select() returns a reactive getter scoped to a slice", () => {
    const store = createFakeZustandStore({ bears: 1, honey: 0 });
    plugin(zustandAdapter({ store }));
    const api = inject<ZustandAdapterAPI<BearState>>("zustand");

    const bears = api.select((s) => s.bears);
    expect(bears()).toBe(1);

    api.setState((s) => ({ bears: s.bears + 1 }));
    expect(bears()).toBe(2);
  });

  it("setState() forwards to the underlying store (functional updater)", () => {
    const store = createFakeZustandStore({ bears: 10, honey: 0 });
    const setStateSpy = vi.spyOn(store, "setState");
    plugin(zustandAdapter({ store }));
    const api = inject<ZustandAdapterAPI<BearState>>("zustand");

    api.setState((s) => ({ honey: s.bears * 2 }));
    expect(setStateSpy).toHaveBeenCalled();
    expect(store.getState().honey).toBe(20);
  });

  it("destroy() unsubscribes AND destroys the underlying store", () => {
    const store = createFakeZustandStore({ bears: 0, honey: 0 });
    const destroySpy = vi.spyOn(store, "destroy");
    plugin(zustandAdapter({ store }));
    const api = inject<ZustandAdapterAPI<BearState>>("zustand");

    api.destroy();
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(store.destroyed).toBe(true);
  });
});
