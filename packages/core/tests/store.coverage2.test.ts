import { describe, expect, it, vi } from "vitest";
import { store } from "../src/core/signals/store";

describe("store coverage2 — proxy & mutation", () => {
  it("exposes reactive getters for own keys", () => {
    const [s] = store({ count: 0, name: "Alice" });
    expect(s.count).toBe(0);
    expect(s.name).toBe("Alice");
  });

  it("falls through to plain target for inherited members (toString/constructor)", () => {
    const [s] = store({ count: 1 });
    expect(typeof s.toString).toBe("function");
    expect(s.constructor).toBe(Object);
    expect(String(s)).toContain("object");
  });

  it("throws on direct mutation", () => {
    const [s] = store({ count: 0 });
    expect(() => {
      (s as any).count = 5;
    }).toThrow(/Direct mutation is not allowed/);
  });
});

describe("store coverage2 — setState & reset", () => {
  it("setState with partial patch updates keys", () => {
    const [s, { setState }] = store({ count: 0, name: "Alice" });
    setState({ count: 10 });
    expect(s.count).toBe(10);
    expect(s.name).toBe("Alice");
  });

  it("setState with updater function receives current snapshot", () => {
    const [s, { setState }] = store({ count: 5 });
    setState((cur) => ({ count: cur.count + 1 }));
    expect(s.count).toBe(6);
  });

  it("setState ignores keys not present in the store", () => {
    const [s, { setState }] = store({ count: 0 });
    setState({ count: 2, nonExistent: 99 } as any);
    expect(s.count).toBe(2);
    expect((s as any).nonExistent).toBeUndefined();
  });

  it("reset reverts to initial state", () => {
    const [s, { setState, reset }] = store({ count: 0, name: "Alice" });
    setState({ count: 99, name: "Bob" });
    expect(s.count).toBe(99);
    reset();
    expect(s.count).toBe(0);
    expect(s.name).toBe("Alice");
  });

  it("getSnapshot returns a non-reactive copy", () => {
    const [, { setState, getSnapshot }] = store({ a: 1, b: 2 });
    const snap = getSnapshot();
    expect(snap).toEqual({ a: 1, b: 2 });
    setState({ a: 10 });
    expect(snap.a).toBe(1); // old snapshot unchanged
    expect(getSnapshot().a).toBe(10);
  });
});

describe("store coverage2 — subscribe", () => {
  it("subscribe fires after change (skips initial) and unsubscribes", () => {
    const [, { setState, subscribe }] = store({ count: 0 });
    const spy = vi.fn();
    const unsub = subscribe(spy);
    expect(spy).not.toHaveBeenCalled(); // skips initial
    setState({ count: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ count: 1 });
    unsub();
    setState({ count: 2 });
    expect(spy).toHaveBeenCalledTimes(1); // no more after unsub
  });
});

describe("store coverage2 — subscribeKey", () => {
  it("fires only when the specific key changes, with value+prev", () => {
    const [, { setState, subscribeKey }] = store({ count: 0, name: "Alice" });
    const spy = vi.fn();
    const unsub = subscribeKey("count", spy);
    expect(spy).not.toHaveBeenCalled();
    setState({ name: "Bob" }); // unrelated key — should not fire
    expect(spy).not.toHaveBeenCalled();
    setState({ count: 5 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(5, 0);
    unsub();
    setState({ count: 9 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not fire when the key is set to the same value", () => {
    const [, { setState, subscribeKey }] = store({ count: 0 });
    const spy = vi.fn();
    subscribeKey("count", spy);
    setState({ count: 0 }); // same value (Object.is) — no fire
    expect(spy).not.toHaveBeenCalled();
  });
});
