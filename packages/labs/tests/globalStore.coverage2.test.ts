import { afterEach, describe, expect, it, vi } from "vitest";
import { globalStore } from "../src/patterns/globalStore";

interface CounterState extends Record<string, unknown> {
  count: number;
  name: string;
}

const makeStore = (middleware?: Parameters<typeof globalStore<CounterState, never>>[0]["middleware"]) =>
  globalStore<
    CounterState,
    {
      increment: (s: CounterState, by?: number) => Partial<CounterState>;
      setName: (s: CounterState, name?: string) => Partial<CounterState>;
      malicious: (s: CounterState) => Partial<CounterState>;
    }
  >({
    state: { count: 0, name: "init" },
    actions: {
      increment: (s, by) => ({ count: s.count + ((by as number) ?? 1) }),
      setName: (_s, name) => ({ name: name as string }),
      // Returns prototype-pollution keys that must be stripped.
      malicious: () =>
        ({ __proto__: { polluted: true }, constructor: "x", prototype: "y", count: 99 }) as Partial<CounterState>,
    },
    middleware,
  });

describe("globalStore coverage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches an action and updates state", () => {
    const store = makeStore();
    expect(store.getState().count).toBe(0);
    store.dispatch("increment", 5);
    expect(store.getState().count).toBe(5);
    store.dispatch("increment");
    expect(store.getState().count).toBe(6);
  });

  it("throws on an unknown action", () => {
    const store = makeStore();
    // @ts-expect-error testing runtime guard
    expect(() => store.dispatch("nope")).toThrow(/Unknown action/);
  });

  it("strips prototype-pollution keys from action patches", () => {
    const store = makeStore();
    store.dispatch("malicious");
    const state = store.getState();
    expect(state.count).toBe(99);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(state, "constructor")).toBe(false);
    expect(Object.hasOwn(state, "prototype")).toBe(false);
  });

  it("select returns a derived getter that tracks state", () => {
    const store = makeStore();
    const count = store.select((s) => s.count);
    expect(count()).toBe(0);
    store.dispatch("increment", 3);
    expect(count()).toBe(3);
  });

  it("subscribe notifies listeners and unsubscribe stops them", () => {
    const store = makeStore();
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.dispatch("increment");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].count).toBe(1);

    unsub();
    store.dispatch("increment");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reset restores initial state and notifies listeners", () => {
    const store = makeStore();
    store.dispatch("increment", 10);
    store.dispatch("setName", "changed");
    const listener = vi.fn();
    store.subscribe(listener);

    store.reset();
    expect(store.getState().count).toBe(0);
    expect(store.getState().name).toBe("init");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("runs middleware chain in order and reaches execute via next()", () => {
    const order: string[] = [];
    const mw1 = vi.fn((_s, action, _p, next) => {
      order.push(`mw1:${action}`);
      next();
    });
    const mw2 = vi.fn((_s, action, _p, next) => {
      order.push(`mw2:${action}`);
      next();
    });
    const store = makeStore([mw1, mw2]);
    store.dispatch("increment", 4);

    expect(order).toEqual(["mw1:increment", "mw2:increment"]);
    expect(store.getState().count).toBe(4);
  });

  it("middleware can short-circuit by not calling next()", () => {
    const blocker = vi.fn(() => {
      /* never calls next */
    });
    const store = makeStore([blocker]);
    store.dispatch("increment", 7);
    // State unchanged because execute() was never reached.
    expect(store.getState().count).toBe(0);
    expect(blocker).toHaveBeenCalledTimes(1);
  });

  it("clones initial state so external mutation does not leak in", () => {
    const initial: CounterState = { count: 0, name: "x" };
    const store = globalStore<CounterState, { noop: (s: CounterState) => Partial<CounterState> }>({
      state: initial,
      actions: { noop: () => ({}) },
    });
    initial.count = 999;
    expect(store.getState().count).toBe(0);
  });

  it("uses the recursive deepClone fallback when structuredClone is unavailable", () => {
    const original = globalThis.structuredClone;
    // Force the fallback branch.
    (globalThis as { structuredClone?: unknown }).structuredClone = undefined;
    try {
      const date = new Date(0);
      const map = new Map([["k", 1]]);
      const set = new Set([1, 2]);
      const state = {
        count: 0,
        when: date,
        tags: ["a", "b"],
        lookup: map,
        unique: set,
        nested: { deep: { value: 1 } },
      } as Record<string, unknown>;

      const store = globalStore<typeof state, { noop: (s: typeof state) => Partial<typeof state> }>({
        state,
        actions: { noop: () => ({}) },
      });

      const cloned = store.getState();
      // Deep cloned: not the same references.
      expect(cloned.when).not.toBe(date);
      expect((cloned.when as Date).getTime()).toBe(0);
      expect(cloned.tags).not.toBe(state.tags);
      expect(cloned.tags).toEqual(["a", "b"]);
      expect(cloned.lookup).not.toBe(map);
      expect((cloned.lookup as Map<string, number>).get("k")).toBe(1);
      expect(cloned.unique).not.toBe(set);
      expect(Array.from(cloned.unique as Set<number>)).toEqual([1, 2]);
      expect(cloned.nested).not.toBe(state.nested);
      expect((cloned.nested as { deep: { value: number } }).deep.value).toBe(1);
    } finally {
      (globalThis as { structuredClone?: unknown }).structuredClone = original;
    }
  });

  it("deepClone fallback throws on circular references", () => {
    const original = globalThis.structuredClone;
    (globalThis as { structuredClone?: unknown }).structuredClone = undefined;
    try {
      const circular: Record<string, unknown> = { count: 0 };
      circular.self = circular;
      expect(() =>
        globalStore<typeof circular, { noop: (s: typeof circular) => Partial<typeof circular> }>({
          state: circular,
          actions: { noop: () => ({}) },
        }),
      ).toThrow(/circular reference/);
    } finally {
      (globalThis as { structuredClone?: unknown }).structuredClone = original;
    }
  });

  it("deepClone fallback skips __proto__ keys", () => {
    const original = globalThis.structuredClone;
    (globalThis as { structuredClone?: unknown }).structuredClone = undefined;
    try {
      const state = JSON.parse('{"count": 0, "__proto__": {"polluted": true}}') as Record<string, unknown>;
      const store = globalStore<typeof state, { noop: (s: typeof state) => Partial<typeof state> }>({
        state,
        actions: { noop: () => ({}) },
      });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(store.getState().count).toBe(0);
    } finally {
      (globalThis as { structuredClone?: unknown }).structuredClone = original;
    }
  });
});
