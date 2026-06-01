import { describe, expect, it, vi } from "vitest";
import { globalStore } from "../src/patterns/globalStore";

describe("globalStore", () => {
  it("should initialize with state", () => {
    const store = globalStore({
      state: { count: 0, name: "test" },
      actions: {
        increment: (state) => ({ count: state.count + 1 }),
        setName: (_state, name: string) => ({ name }),
      },
    });

    expect(store.getState()).toEqual({ count: 0, name: "test" });
  });

  it("should dispatch actions", () => {
    const store = globalStore({
      state: { count: 0 },
      actions: {
        increment: (state) => ({ count: state.count + 1 }),
        add: (state, amount: number) => ({ count: state.count + amount }),
      },
    });

    store.dispatch("increment");
    expect(store.getState()).toEqual({ count: 1 });

    store.dispatch("add", 5);
    expect(store.getState()).toEqual({ count: 6 });
  });

  it("should support subscribers", () => {
    const store = globalStore({
      state: { count: 0 },
      actions: {
        increment: (state) => ({ count: state.count + 1 }),
      },
    });

    const callback = vi.fn();
    const unsub = store.subscribe(callback);

    store.dispatch("increment");
    expect(callback).toHaveBeenCalledWith({ count: 1 });

    unsub();
    store.dispatch("increment");
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("should reset to initial state", () => {
    const store = globalStore({
      state: { count: 0 },
      actions: {
        increment: (state) => ({ count: state.count + 1 }),
      },
    });

    store.dispatch("increment");
    store.dispatch("increment");
    expect(store.getState()).toEqual({ count: 2 });

    store.reset();
    expect(store.getState()).toEqual({ count: 0 });
  });

  it("should support middleware", () => {
    const log: string[] = [];
    const store = globalStore({
      state: { count: 0 },
      actions: {
        increment: (state) => ({ count: state.count + 1 }),
      },
      middleware: [
        (_state, action, _payload, next) => {
          log.push(`before:${action}`);
          next();
          log.push(`after:${action}`);
        },
      ],
    });

    store.dispatch("increment");
    expect(log).toEqual(["before:increment", "after:increment"]);
    expect(store.getState()).toEqual({ count: 1 });
  });

  it("does not allow prototype pollution via a dispatched patch", () => {
    const store = globalStore({
      state: { count: 0 },
      actions: {
        // An action that returns server-shaped data including a __proto__ key.
        evil: () => JSON.parse('{"count":1,"__proto__":{"polluted":true}}'),
      },
    });

    store.dispatch("evil");
    // The legitimate key applies; the prototype is untouched.
    expect(store.getState().count).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });
});
