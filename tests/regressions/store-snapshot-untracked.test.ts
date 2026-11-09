import { describe, expect, it } from "vitest";
import { derived } from "../../src/core/signals/derived";
import { effect } from "../../src/core/signals/effect";
import { signal } from "../../src/core/signals/signal";
import { store } from "../../src/core/signals/store";
import { untracked } from "../../src/reactivity/track";

describe("store getSnapshot() is untracked (audit F6)", () => {
  it("does not subscribe a calling effect", () => {
    const [, actions] = store({ count: 0 });
    let runs = 0;
    const stop = effect(() => {
      actions.getSnapshot();
      runs++;
    });

    actions.setState({ count: 1 });
    stop();

    expect(runs).toBe(1);
  });

  it("does not subscribe a calling derived", () => {
    const [, actions] = store({ count: 0 });
    let computes = 0;
    const seen = derived(() => {
      computes++;
      return actions.getSnapshot().count;
    });

    expect(seen()).toBe(0);
    actions.setState({ count: 1 });

    expect(seen()).toBe(0);
    expect(computes).toBe(1);
  });

  it("still returns the current values when called inside an effect", () => {
    const [, actions] = store({ count: 0 });
    const [trigger, setTrigger] = signal(0);
    const seen: number[] = [];
    const stop = effect(() => {
      trigger();
      seen.push(actions.getSnapshot().count);
    });

    actions.setState({ count: 5 });
    setTrigger(1);
    stop();

    expect(seen).toEqual([0, 5]);
  });

  it("leaves the caller's own dependencies on either side of the call intact", () => {
    const [, actions] = store({ count: 0 });
    const [before, setBefore] = signal(0);
    const [after, setAfter] = signal(0);
    let runs = 0;
    const stop = effect(() => {
      before();
      actions.getSnapshot();
      after();
      runs++;
    });

    setBefore(1);
    expect(runs).toBe(2);
    setAfter(1);
    expect(runs).toBe(3);
    actions.setState({ count: 1 });
    expect(runs).toBe(3);
    stop();
  });
});

describe("store actions do not subscribe the computation that calls them (audit F6)", () => {
  it("setState with a patch does not subscribe a calling effect", () => {
    const [, actions] = store({ count: 0, other: 0 });
    let runs = 0;
    const stop = effect(() => {
      actions.setState({ count: 1 });
      runs++;
    });

    actions.setState({ other: 1 });
    actions.setState({ count: 2 });
    stop();

    expect(runs).toBe(1);
  });

  it("setState with an updater does not subscribe a calling effect through its argument", () => {
    const [, actions] = store({ count: 0, other: 0 });
    let runs = 0;
    const stop = effect(() => {
      actions.setState((state) => ({ ...state, count: state.count + 1 }));
      runs++;
    });

    actions.setState({ other: 1 });
    stop();

    expect(runs).toBe(1);
    expect(actions.getSnapshot()).toEqual({ count: 1, other: 1 });
  });

  it("reset does not subscribe a calling effect", () => {
    const [, actions] = store({ count: 0 });
    let runs = 0;
    const stop = effect(() => {
      actions.reset();
      runs++;
    });

    actions.setState({ count: 1 });
    stop();

    expect(runs).toBe(1);
  });
});

describe("store subscribe() still tracks every key (audit F6)", () => {
  it("fires for a change to any key and skips the initial run", () => {
    const [, actions] = store({ a: 1, b: 2 });
    const seen: Array<{ a: number; b: number }> = [];
    const stop = actions.subscribe((state) => seen.push(state));

    expect(seen).toEqual([]);
    actions.setState({ a: 10 });
    actions.setState({ b: 20 });
    stop();

    expect(seen).toEqual([
      { a: 10, b: 2 },
      { a: 10, b: 20 },
    ]);
  });

  it("fires once for a patch that writes several keys", () => {
    const [, actions] = store({ a: 1, b: 2 });
    let fires = 0;
    const stop = actions.subscribe(() => fires++);

    actions.setState({ a: 10, b: 20 });
    stop();

    expect(fires).toBe(1);
  });

  it("keeps tracking when the subscription is created inside untracked()", () => {
    const [, actions] = store({ a: 1 });
    const seen: number[] = [];
    const stop = untracked(() => actions.subscribe((state) => seen.push(state.a)));

    actions.setState({ a: 2 });
    stop();

    expect(seen).toEqual([2]);
  });

  it("keeps tracking after its callback reads getSnapshot()", () => {
    const [, actions] = store({ a: 1 });
    const seen: number[] = [];
    const stop = actions.subscribe(() => seen.push(actions.getSnapshot().a));

    actions.setState({ a: 2 });
    actions.setState({ a: 3 });
    stop();

    expect(seen).toEqual([2, 3]);
  });
});
