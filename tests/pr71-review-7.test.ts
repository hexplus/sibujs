import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { globalStore, type Middleware } from "../src/patterns/globalStore";

type Count = { count: number };

let handler: ReturnType<typeof vi.fn>;
let unhandled: ReturnType<typeof vi.fn>;
beforeEach(() => {
  handler = vi.fn();
  setRuntimeErrorHandler(handler);
  unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
});
afterEach(() => {
  setRuntimeErrorHandler(null);
  process.off("unhandledRejection", unhandled);
  vi.restoreAllMocks();
});

const flush = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
};

function storeWith(middleware: Middleware<Count>) {
  const action = vi.fn((state: Count) => ({ count: state.count + 1 }));
  const listener = vi.fn();
  const store = globalStore({ state: { count: 0 }, actions: { inc: action }, middleware: [middleware] });
  store.subscribe(listener);
  return { store, action, listener };
}

// ---------------------------------------------------------------------------
// 1. A failed middleware never continues; async failures are reported.
// ---------------------------------------------------------------------------
describe("globalStore middleware failure lifecycle", () => {
  it("scheduling next() and then throwing synchronously never runs the action", async () => {
    let captured: (() => void) | undefined;
    const { store, action, listener } = storeWith((_s, _a, _p, next) => {
      captured = next;
      setTimeout(next, 0);
      throw new Error("middleware failed");
    });
    expect(() => store.dispatch("inc")).toThrow("middleware failed");
    await flush();
    captured?.();
    await flush();

    expect(action).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(store.getState().count).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a promise rejecting before next() is reported once and invalidates the continuation", async () => {
    let captured: (() => void) | undefined;
    const { store, action } = storeWith(async (_s, _a, _p, next) => {
      captured = next;
      await Promise.resolve();
      throw new Error("async middleware failed");
    });
    expect(() => store.dispatch("inc")).not.toThrow();
    await flush();
    captured?.();
    await flush();

    expect(action).not.toHaveBeenCalled();
    expect(store.getState().count).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ message: "async middleware failed" });
    expect(handler.mock.calls[0][1]).toMatchObject({ phase: "async", name: "globalStore(middleware)" });
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("a promise rejecting after next() keeps the committed action and is reported once", async () => {
    const { store, action } = storeWith(async (_s, _a, _p, next) => {
      await Promise.resolve();
      next();
      throw new Error("after next");
    });
    store.dispatch("inc");
    await flush();
    expect(action).toHaveBeenCalledTimes(1);
    expect(store.getState().count).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("an async middleware that schedules next() after rejecting is ignored", async () => {
    const { store, action } = storeWith(async (_s, _a, _p, next) => {
      setTimeout(next, 20);
      await Promise.resolve();
      throw new Error("rejected first");
    });
    store.dispatch("inc");
    await flush();
    await new Promise((r) => setTimeout(r, 40));
    await flush();
    expect(action).not.toHaveBeenCalled();
    expect(store.getState().count).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a hostile then getter is reported once and invalidates the continuation", async () => {
    let captured: (() => void) | undefined;
    const { store, action } = storeWith(
      (_s, _a, _p, next) =>
        ({
          // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the subject under test
          get then() {
            captured = next;
            throw new Error("hostile getter");
          },
        }) as unknown as PromiseLike<void>,
    );
    store.dispatch("inc");
    await flush();
    captured?.();
    await flush();
    expect(action).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ message: "hostile getter" });
  });

  it("a throwing then invocation is reported once and invalidates the continuation", async () => {
    let captured: (() => void) | undefined;
    const { store, action } = storeWith((_s, _a, _p, next) => {
      captured = next;
      return {
        // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the subject under test
        then() {
          throw new Error("then threw");
        },
      } as unknown as PromiseLike<void>;
    });
    store.dispatch("inc");
    await flush();
    captured?.();
    captured?.();
    await flush();
    expect(action).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("next() called synchronously and then a throw keeps the committed action", () => {
    const { store, action } = storeWith((_s, _a, _p, next) => {
      next();
      throw new Error("after sync next");
    });
    expect(() => store.dispatch("inc")).toThrow("after sync next");
    expect(action).toHaveBeenCalledTimes(1);
    expect(store.getState().count).toBe(1);
  });

  it("a well-behaved async middleware still continues after an await", async () => {
    const { store, action, listener } = storeWith(async (_s, _a, _p, next) => {
      await Promise.resolve();
      next();
    });
    store.dispatch("inc");
    await flush();
    expect(action).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. The operation queue drains linearly and keeps order.
// ---------------------------------------------------------------------------
describe("globalStore operation queue draining", () => {
  const burst = (size: number) => {
    const store = globalStore({
      state: { count: 0 },
      actions: { inc: (state: Count) => ({ count: state.count + 1 }) },
    });
    const rounds: number[] = [];
    let queued = false;
    store.subscribe((state) => {
      rounds.push(state.count);
      if (queued) return;
      queued = true;
      for (let i = 0; i < size; i++) store.dispatch("inc");
    });
    const started = performance.now();
    store.dispatch("inc");
    return { elapsed: performance.now() - started, rounds, store };
  };

  it("a large reentrant burst preserves order and processes everything queued during draining", () => {
    const { rounds, store } = burst(50_000);
    expect(store.getState().count).toBe(50_001);
    expect(rounds).toHaveLength(50_001);
    for (let i = 0; i < rounds.length; i++) {
      if (rounds[i] !== i + 1) throw new Error(`round ${i} delivered ${rounds[i]}`);
    }
  });

  it("drain work scales roughly linearly when the burst doubles", () => {
    burst(20_000); // warm up
    const best = (size: number) => Math.min(burst(size).elapsed, burst(size).elapsed, burst(size).elapsed);
    const measure = () => best(80_000) / Math.max(best(40_000), 0.5);
    let ratio = measure();
    // Noise only inflates the ratio; re-measure once before failing. Linear is
    // ~2x, quadratic ~4x.
    if (ratio >= 3.2) ratio = measure();
    expect(ratio).toBeLessThan(3.2);
  }, 60_000);

  it("the queue keeps working after an operation fails mid-drain", () => {
    const store = globalStore({
      state: { count: 0 },
      actions: {
        inc: (state: Count) => ({ count: state.count + 1 }),
        boom: (): Partial<Count> => {
          throw new Error("queued failure");
        },
      },
    });
    const rounds: number[] = [];
    store.subscribe((state) => {
      rounds.push(state.count);
      if (state.count === 1) {
        store.dispatch("boom");
        store.dispatch("inc");
      }
    });
    store.dispatch("inc");
    expect(rounds).toEqual([1, 2]);
    expect(handler).toHaveBeenCalledTimes(1);

    // A fresh drain after the failure starts clean.
    store.dispatch("inc");
    expect(rounds).toEqual([1, 2, 3]);
  });
});
