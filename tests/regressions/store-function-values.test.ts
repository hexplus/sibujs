import { describe, expect, it, vi } from "vitest";
import { store } from "../../src/core/signals/store";

type Callback = () => string;

describe("store keeps function-valued fields as values (audit F7)", () => {
  it("stores a function from a patch without calling it", () => {
    const old = vi.fn<Callback>(() => "old");
    const next = vi.fn<Callback>(() => "new");
    const [state, actions] = store<{ callback: Callback }>({ callback: old });

    actions.setState({ callback: next });

    expect(state.callback).toBe(next);
    expect(old).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("stores a function returned by a whole-state updater without calling it", () => {
    const old = vi.fn<Callback>(() => "old");
    const next = vi.fn<Callback>(() => "new");
    const [state, actions] = store<{ callback: Callback; count: number }>({ callback: old, count: 0 });

    actions.setState((current) => ({ ...current, callback: next, count: current.count + 1 }));

    expect(state.callback).toBe(next);
    expect(state.count).toBe(1);
    expect(old).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("keeps an unchanged function when an updater spreads the current state", () => {
    const callback = vi.fn<Callback>(() => "value");
    const [state, actions] = store<{ callback: Callback; count: number }>({ callback, count: 0 });

    actions.setState((current) => ({ ...current, count: 1 }));

    expect(state.callback).toBe(callback);
    expect(callback).not.toHaveBeenCalled();
  });

  it("restores a function on reset without calling either one", () => {
    const initial = vi.fn<Callback>(() => "initial");
    const replaced = vi.fn<Callback>(() => "replaced");
    const [state, actions] = store<{ callback: Callback }>({ callback: initial });
    actions.setState({ callback: replaced });

    actions.reset();

    expect(state.callback).toBe(initial);
    expect(initial).not.toHaveBeenCalled();
    expect(replaced).not.toHaveBeenCalled();
  });

  it("reports a replaced function to subscribers by identity", () => {
    const old: Callback = () => "old";
    const next: Callback = () => "new";
    const [, actions] = store<{ callback: Callback }>({ callback: old });
    const keyChanges: [Callback, Callback][] = [];
    const snapshots: Callback[] = [];
    const stopKey = actions.subscribeKey("callback", (value, prev) => keyChanges.push([value, prev]));
    const stopAll = actions.subscribe((current) => snapshots.push(current.callback));

    actions.setState({ callback: next });
    stopKey();
    stopAll();

    expect(keyChanges).toEqual([[next, old]]);
    expect(snapshots).toEqual([next]);
  });

  it("does not notify when a patch writes the same function again", () => {
    const callback: Callback = () => "value";
    const [, actions] = store<{ callback: Callback }>({ callback });
    let fires = 0;
    const stop = actions.subscribe(() => fires++);

    actions.setState({ callback });
    stop();

    expect(fires).toBe(0);
  });

  it("returns stored functions from getSnapshot by identity", () => {
    const next: Callback = () => "new";
    const [, actions] = store<{ callback: Callback | null }>({ callback: null });

    actions.setState({ callback: next });

    expect(actions.getSnapshot().callback).toBe(next);
  });

  it("still writes non-function values through patches and reset", () => {
    const [state, actions] = store<{ count: number; label: string | undefined }>({ count: 0, label: "a" });

    actions.setState({ count: 2, label: undefined });
    expect(state.count).toBe(2);
    expect(state.label).toBeUndefined();

    actions.reset();
    expect(state.count).toBe(0);
    expect(state.label).toBe("a");
  });
});
