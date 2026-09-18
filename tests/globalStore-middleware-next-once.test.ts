import { afterEach, describe, expect, it, vi } from "vitest";
import { globalStore, type Middleware } from "../src/patterns/globalStore";

// ---------------------------------------------------------------------------
// A middleware's `next()` advances the chain at most once.
//
// THE DEFECT: every middleware shared one `next` closure over a single index.
// Calling `next()` twice ran the action twice — `count` jumped by 2 for one
// dispatch — and with several middlewares the second call skipped straight past
// the ones after it to the action, bypassing them.
// ---------------------------------------------------------------------------

type State = { count: number };

function makeStore(middleware: Middleware<State>[]) {
  return globalStore({
    state: { count: 0 },
    actions: {
      increment: (s: State) => ({ count: s.count + 1 }),
    },
    middleware,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("globalStore middleware next()", () => {
  it("calling next() twice applies the action once", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = makeStore([
      (_state, _action, _payload, next) => {
        next();
        next();
      },
    ]);
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatch("increment");

    expect(store.getState().count).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a repeated next() cannot bypass the middlewares after it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const order: string[] = [];
    const store = makeStore([
      (_state, _action, _payload, next) => {
        order.push("first");
        next();
        next();
      },
      (_state, _action, _payload, next) => {
        order.push("second");
        next();
      },
    ]);

    store.dispatch("increment");

    expect(order).toEqual(["first", "second"]);
    expect(store.getState().count).toBe(1);
  });

  it("warns in development when next() is called more than once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = makeStore([
      (_state, _action, _payload, next) => {
        next();
        next();
      },
    ]);

    store.dispatch("increment");

    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("next() called more than once");
  });

  it("each dispatch gets a fresh chain", () => {
    const store = makeStore([(_state, _action, _payload, next) => next()]);

    store.dispatch("increment");
    store.dispatch("increment");
    store.dispatch("increment");

    expect(store.getState().count).toBe(3);
  });

  it("a middleware that never calls next() still short-circuits", () => {
    const store = makeStore([() => {}]);

    store.dispatch("increment");

    expect(store.getState().count).toBe(0);
  });
});
