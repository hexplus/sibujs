import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effect, on } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { disableSSR, enableSSR } from "../src/core/ssr-context";

describe("effect coverage2 — on()", () => {
  it("on() runs handler with undefined prev on first call, then prev on later", () => {
    const [count, setCount] = signal(0);
    const calls: [number, number | undefined][] = [];
    effect(
      on(
        () => count(),
        (value, prev) => {
          calls.push([value, prev]);
        },
      ),
    );
    expect(calls).toEqual([[0, undefined]]);
    setCount(5);
    expect(calls).toEqual([
      [0, undefined],
      [5, 0],
    ]);
    setCount(9);
    expect(calls[2]).toEqual([9, 5]);
  });

  it("on() does not track signals read inside the handler", () => {
    const [count, setCount] = signal(0);
    const [other, setOther] = signal("a");
    const spy = vi.fn(() => {
      other(); // read but should not be tracked
    });
    effect(on(() => count(), spy));
    expect(spy).toHaveBeenCalledTimes(1);
    setOther("b"); // must NOT trigger
    expect(spy).toHaveBeenCalledTimes(1);
    setCount(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("effect coverage2 — SSR no-op", () => {
  beforeEach(() => enableSSR());
  afterEach(() => disableSSR());

  it("effect is a no-op in SSR and returns a disposer", () => {
    const spy = vi.fn();
    const dispose = effect(spy);
    expect(spy).not.toHaveBeenCalled();
    expect(typeof dispose).toBe("function");
    expect(() => dispose()).not.toThrow();
  });
});

describe("effect coverage2 — onError option", () => {
  it("routes thrown errors to onError handler", () => {
    const [count, setCount] = signal(0);
    const errors: unknown[] = [];
    effect(
      () => {
        count();
        throw new Error("boom");
      },
      { onError: (e) => errors.push(e) },
    );
    expect(errors).toHaveLength(1);
    setCount(1);
    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe("boom");
  });
});

describe("effect coverage2 — cleanup & reruns", () => {
  it("runs registered onCleanup before re-run and on dispose", () => {
    const [count, setCount] = signal(0);
    const cleanups: number[] = [];
    const dispose = effect((onCleanup) => {
      const c = count();
      onCleanup(() => cleanups.push(c));
    });
    expect(cleanups).toEqual([]);
    setCount(1);
    expect(cleanups).toEqual([0]); // cleanup of first run flushed before second
    dispose();
    expect(cleanups).toEqual([0, 1]);
  });

  it("dispose is idempotent (second call no-op)", () => {
    const dispose = effect(() => {});
    dispose();
    expect(() => dispose()).not.toThrow();
  });

  it("onCleanup that throws is caught and warned", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [count, setCount] = signal(0);
    effect((onCleanup) => {
      count();
      onCleanup(() => {
        throw new Error("cleanup fail");
      });
    });
    setCount(1); // triggers flushUserCleanups which catches
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("effect that writes to its own dep mid-body drains reruns", () => {
    const [count, setCount] = signal(0);
    const seen: number[] = [];
    effect(() => {
      const c = count();
      seen.push(c);
      if (c < 3) setCount(c + 1);
    });
    // Should converge through drainReruns to 3
    expect(seen[seen.length - 1]).toBe(3);
  });
});

describe("effect coverage2 — MAX_RERUNS cap", () => {
  it("breaks the loop and logs when an effect re-requests itself 100+ times", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const [count, setCount] = signal(0);
    effect(() => {
      const c = count();
      // Always write a higher value — never stabilizes, trips MAX_RERUNS
      setCount(c + 1);
    });
    expect(errSpy).toHaveBeenCalled();
    const msg = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toContain("re-requested itself");
    errSpy.mockRestore();
  });
});

describe("effect coverage2 — devtools hook & dispose error paths", () => {
  afterEach(() => {
    delete (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  });

  it("emits effect:create and effect:destroy via devtools hook", () => {
    const events: string[] = [];
    (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__ = {
      emit: (name: string) => {
        events.push(name);
      },
    };
    const dispose = effect(() => {});
    expect(events).toContain("effect:create");
    dispose();
    expect(events).toContain("effect:destroy");
  });

  it("swallows a throwing devtools hook during destroy", () => {
    (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__ = {
      emit: (name: string) => {
        if (name === "effect:destroy") throw new Error("hook fail");
      },
    };
    const dispose = effect(() => {});
    expect(() => dispose()).not.toThrow();
  });

  it("catches onCleanup throwing during dispose", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispose = effect((onCleanup) => {
      onCleanup(() => {
        throw new Error("cleanup-on-dispose");
      });
    });
    expect(() => dispose()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("effect coverage2 — reentrancy guard", () => {
  it("re-entrant trigger while running sets rerunPending path", () => {
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    let runs = 0;
    effect(() => {
      runs++;
      a();
      // Writing b inside doesn't affect this effect (not a dep), so no loop
      if (runs === 1) setB(b() + 1);
    });
    const before = runs;
    setA(1);
    expect(runs).toBeGreaterThan(before);
  });
});
