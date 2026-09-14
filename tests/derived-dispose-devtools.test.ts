import { afterEach, describe, expect, it } from "vitest";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { getActiveDevTools, initDevTools } from "../src/devtools/devtools";
import { getSubscriberCount } from "../src/devtools/introspect";

type Hook = { nodes: Map<number, { type: string; ref: unknown }> };

const getHook = (): Hook => (globalThis as unknown as Record<string, Hook>).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
const computedCount = (): number => [...getHook().nodes.values()].filter((n) => n.type === "computed").length;

afterEach(() => {
  getActiveDevTools()?.destroy();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__SIBU__;
  delete (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS__;
});

describe("derived().dispose() with DevTools attached", () => {
  it("removes disposed deriveds from the node inventory", () => {
    initDevTools();
    const [n] = signal(1);
    const flags = Array.from({ length: 50 }, (_, i) => derived(() => n() > i));
    expect(computedCount()).toBe(50);

    for (const flag of flags) flag.dispose();
    expect(computedCount()).toBe(0);

    // Idempotent disposal emits nothing that could remove an unrelated node.
    const survivor = derived(() => n() * 2);
    flags[0].dispose();
    expect(computedCount()).toBe(1);
    expect(
      [...getHook().nodes.values()].some((node) => node.ref === (survivor as never as { __signal: unknown }).__signal),
    ).toBe(true);
  });

  it("reports disposal to a hook attached after the derived was created", () => {
    const [n] = signal(1);
    const early = derived(() => n() + 1);
    initDevTools();
    const late = derived(() => n() + 2);
    expect(computedCount()).toBe(1);

    early.dispose();
    late.dispose();
    expect(computedCount()).toBe(0);
  });
});

describe("derived().dispose() called by its own getter during recomputation", () => {
  type Mode = "before-read" | "after-read";

  function setup(mode: Mode) {
    initDevTools();
    const hook = getHook() as Hook & { on: (event: string, fn: () => void) => () => void };
    let destroyEvents = 0;
    hook.on("computed:destroy", () => {
      destroyEvents++;
    });

    const [a, setA] = signal(1);
    const [b, setB] = signal(10);
    let disposeNow = false;
    let runs = 0;
    const sum = derived(() => {
      runs++;
      if (disposeNow && mode === "before-read") sum.dispose();
      const first = a();
      if (disposeNow && mode === "after-read") sum.dispose();
      return first + b();
    });

    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(sum());
    });

    return {
      a,
      b,
      setA,
      setB,
      sum,
      seen,
      stop,
      runs: () => runs,
      destroyEvents: () => destroyEvents,
      arm: () => {
        disposeNow = true;
      },
    };
  }

  for (const mode of ["before-read", "after-read"] as const) {
    it(`releases every edge when dispose() runs ${mode === "before-read" ? "before" : "after"} a dependency read`, () => {
      const t = setup(mode);
      expect(t.seen).toEqual([11]);
      expect(computedCount()).toBe(1);

      t.arm();
      t.setA(2); // the effect pulls `sum`, whose recomputation disposes it

      // The disposing run settles the frozen value; nothing is subscribed.
      expect(t.seen).toEqual([11, 12]);
      expect(getSubscriberCount(t.a)).toBe(0);
      expect(getSubscriberCount(t.b)).toBe(0);
      expect(computedCount()).toBe(0);
      expect(t.destroyEvents()).toBe(1);

      const runsAfterDispose = t.runs();
      t.setA(5);
      t.setB(50);
      expect(t.sum()).toBe(12);
      expect(t.runs()).toBe(runsAfterDispose);
      expect(t.seen).toEqual([11, 12]);
      expect(getSubscriberCount(t.a)).toBe(0);
      expect(getSubscriberCount(t.b)).toBe(0);

      t.sum.dispose();
      expect(t.destroyEvents()).toBe(1);
      t.stop();
    });
  }

  it("a direct read that self-disposes also leaves no edges", () => {
    const [a, setA] = signal(1);
    let disposeNow = false;
    let runs = 0;
    const d = derived(() => {
      runs++;
      if (disposeNow) d.dispose();
      return a() * 2;
    });
    disposeNow = true;
    setA(2);
    expect(d()).toBe(4);
    expect(getSubscriberCount(a)).toBe(0);
    setA(3);
    expect(d()).toBe(4);
    expect(runs).toBe(2);
  });
});

describe("DevTools lifecycle event order for a self-disposing derived", () => {
  it("emits no computed:update after computed:destroy", () => {
    initDevTools();
    const hook = getHook() as Hook & { on: (event: string, fn: (payload: unknown) => void) => () => void };
    const [a, setA] = signal(1);
    let disposeNow = false;
    const d = derived(() => {
      const value = a() * 2;
      if (disposeNow) d.dispose();
      return value;
    });
    const ref = (d as never as { __signal: unknown }).__signal;
    const events: string[] = [];
    for (const name of ["computed:update", "computed:destroy"]) {
      hook.on(name, (payload) => {
        if ((payload as { signal: unknown }).signal === ref) events.push(name);
      });
    }

    setA(2);
    expect(d()).toBe(4);
    expect(events).toEqual(["computed:update"]);

    disposeNow = true;
    setA(3);
    expect(d()).toBe(6);
    expect(events).toEqual(["computed:update", "computed:destroy"]);
  });
});
