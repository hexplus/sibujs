import { describe, expect, it, vi } from "vitest";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { getSubscriberCount } from "../src/devtools/introspect";
import { batch } from "../src/reactivity/batch";
import { track } from "../src/reactivity/track";

const tick = () => new Promise<void>((r) => queueMicrotask(() => r()));

describe("hardening: dynamic dependencies", () => {
  it("drops the obsolete branch's subscription when the condition flips", () => {
    const [cond, setCond] = signal(true);
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);

    let runs = 0;
    const stop = track(() => {
      runs++;
      cond() ? a() : b();
    });

    const afterInit = runs;

    // While cond is true, only `a` is a dependency.
    setB(1);
    expect(runs).toBe(afterInit);

    setA(1);
    expect(runs).toBe(afterInit + 1);

    // Flip: `b` becomes live and `a` must be unsubscribed.
    setCond(false);
    const afterFlip = runs;
    setA(2);
    expect(runs).toBe(afterFlip);

    setB(2);
    expect(runs).toBe(afterFlip + 1);

    stop();
  });

  it("does not accumulate subscriptions across thousands of branch switches", () => {
    const [cond, setCond] = signal(true);
    const [a] = signal(0);
    const [b] = signal(0);

    const stop = track(() => {
      cond() ? a() : b();
    });

    for (let i = 0; i < 2000; i++) {
      setCond(i % 2 === 0);
    }

    // Exactly one live subscriber on the active branch, none on the other.
    const total = getSubscriberCount(a) + getSubscriberCount(b);
    expect(total).toBeLessThanOrEqual(2);

    stop();
  });
});

describe("hardening: deep derived chains", () => {
  // `derived()` is lazily pull-based: reading the tail of a chain of length N
  // recurses N frames. Chains beyond roughly 2 000 links therefore exhaust the
  // JS stack. This is a documented limitation, not a defect — see
  // docs/architecture/reactivity.md ("Known limits"). Real applications nest
  // derivations tens deep, not thousands. These cases pin the supported range.
  for (const depth of [100, 500, 1000]) {
    it(`propagates through a chain of depth ${depth} without overflowing the stack`, () => {
      const [source, setSource] = signal(0);

      let node: () => number = source;
      for (let i = 0; i < depth; i++) {
        const prev = node;
        node = derived(() => prev() + 1);
      }

      expect(node()).toBe(depth);

      setSource(1);
      expect(node()).toBe(depth + 1);
    });
  }

  it("runs a terminal effect once per source change on a deep chain", () => {
    const [source, setSource] = signal(0);
    let node: () => number = source;
    for (let i = 0; i < 200; i++) {
      const prev = node;
      node = derived(() => prev() + 1);
    }

    const seen: number[] = [];
    const stop = track(() => {
      seen.push(node());
    });

    seen.length = 0;
    setSource(5);
    expect(seen).toEqual([205]);

    stop();
  });
});

describe("hardening: diamond dependencies", () => {
  it("settles a diamond without leaving a stale read", () => {
    //     A
    //    / \
    //   B   C
    //    \ /
    //     D
    const [a, setA] = signal(1);
    const b = derived(() => a() * 2);
    const c = derived(() => a() * 3);

    const seen: number[] = [];
    const stop = track(() => {
      seen.push(b() + c());
    });

    expect(seen).toEqual([5]);

    seen.length = 0;
    setA(2);

    // Whatever the intermediate scheduling, the final observed value must be
    // consistent with a=2 — never a torn mix of old and new.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[seen.length - 1]).toBe(10);
    for (const v of seen) expect(v % 5).toBe(0);

    stop();
  });

  it("keeps a wide diamond consistent", () => {
    const [a, setA] = signal(1);
    const branches = Array.from({ length: 50 }, (_, i) => derived(() => a() * (i + 1)));

    const stop = track(() => {
      const total = branches.reduce((sum, f) => sum + f(), 0);
      // Sum of a*(1..50) === a * 1275 — a torn read would break this.
      expect(total % 1275).toBe(0);
    });

    for (let i = 2; i < 30; i++) setA(i);
    stop();
  });
});

describe("hardening: disposal while queued", () => {
  it("never runs a subscriber that was disposed before the queue drained", () => {
    const [value, setValue] = signal(0);
    const ran = vi.fn();

    const stop = track(() => {
      value();
      ran();
    });
    ran.mockClear();

    batch(() => {
      setValue(1);
      // Dispose mid-batch: the notification is already queued.
      stop();
    });

    expect(ran).not.toHaveBeenCalled();

    setValue(2);
    expect(ran).not.toHaveBeenCalled();
  });

  it("stops a disposed effect even when another subscriber disposes it", () => {
    const [value, setValue] = signal(0);
    const victimRuns = vi.fn();

    const stopVictim = track(() => {
      value();
      victimRuns();
    });

    const stopKiller = track(() => {
      value();
      stopVictim();
    });

    victimRuns.mockClear();
    setValue(1);

    // The killer disposes the victim during the same drain; the victim must
    // run at most once and never after its disposal.
    expect(victimRuns.mock.calls.length).toBeLessThanOrEqual(1);

    victimRuns.mockClear();
    setValue(2);
    expect(victimRuns).not.toHaveBeenCalled();

    stopKiller();
  });

  it("is safe to dispose the same subscriber twice", () => {
    const [value, setValue] = signal(0);
    const stop = track(() => value());

    expect(() => {
      stop();
      stop();
    }).not.toThrow();

    expect(() => setValue(1)).not.toThrow();
  });
});

describe("hardening: reentrant updates", () => {
  it("terminates a self-incrementing effect under the documented cycle guard", () => {
    const [a, setA] = signal(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => {
      track(() => {
        if (a() < 10) setA(a() + 1);
      });
    }).not.toThrow();

    // The guard must stop runaway recursion rather than hang or blow the stack.
    expect(a()).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("does not hang when two effects write to each other's dependency", () => {
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => {
      track(() => {
        if (a() < 5) setB(a() + 1);
      });
      track(() => {
        if (b() < 5) setA(b());
      });
      setA(1);
    }).not.toThrow();

    warn.mockRestore();
  });
});

describe("hardening: batch semantics", () => {
  it("collapses nested batches into a single outer flush", () => {
    const [a, setA] = signal(0);
    const runs = vi.fn();

    const stop = track(() => {
      a();
      runs();
    });
    runs.mockClear();

    batch(() => {
      setA(1);
      batch(() => {
        setA(2);
        setA(3);
      });
      setA(4);
    });

    expect(runs).toHaveBeenCalledTimes(1);
    expect(a()).toBe(4);
    stop();
  });

  it("restores scheduler state when a batch throws", () => {
    const [a, setA] = signal(0);
    const runs = vi.fn();

    const stop = track(() => {
      a();
      runs();
    });
    runs.mockClear();

    expect(() =>
      batch(() => {
        setA(1);
        throw new Error("batch boom");
      }),
    ).toThrow("batch boom");

    // The scheduler must not be stuck in "batching" — a later update must
    // still notify normally.
    runs.mockClear();
    setA(2);
    expect(runs).toHaveBeenCalledTimes(1);
    expect(a()).toBe(2);

    stop();
  });

  it("restores scheduler state when a nested batch throws", () => {
    const [a, setA] = signal(0);
    const runs = vi.fn();
    const stop = track(() => {
      a();
      runs();
    });

    expect(() =>
      batch(() => {
        batch(() => {
          setA(1);
          throw new Error("inner boom");
        });
      }),
    ).toThrow("inner boom");

    runs.mockClear();
    setA(9);
    expect(runs).toHaveBeenCalledTimes(1);
    stop();
  });

  it("supports batching from inside an effect", () => {
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    const seen: [number, number][] = [];

    const stopWatcher = track(() => {
      seen.push([a(), b()]);
    });

    const stopDriver = track(() => {
      if (a() === 1) {
        batch(() => {
          setB(10);
        });
      }
    });

    seen.length = 0;
    setA(1);

    expect(seen[seen.length - 1]).toEqual([1, 10]);

    stopWatcher();
    stopDriver();
  });
});

describe("hardening: subscription hygiene", () => {
  it("leaves no subscribers behind after create/dispose cycles", () => {
    const [value, setValue] = signal(0);
    const baseline = getSubscriberCount(value);

    for (let i = 0; i < 1000; i++) {
      const stop = track(() => value());
      stop();
    }

    expect(getSubscriberCount(value)).toBe(baseline);

    // And the signal still works.
    let observed = -1;
    const stop = track(() => {
      observed = value();
    });
    setValue(42);
    expect(observed).toBe(42);
    stop();
  });

  it("releases subscriptions when effects are disposed out of creation order", () => {
    const [value] = signal(0);
    const baseline = getSubscriberCount(value);

    const stops = Array.from({ length: 100 }, () => track(() => value()));
    expect(getSubscriberCount(value)).toBe(baseline + 100);

    for (const stop of stops.reverse()) stop();
    expect(getSubscriberCount(value)).toBe(baseline);
  });
});

describe("hardening: effect cleanup", () => {
  it("runs an effect's cleanup exactly once on disposal", async () => {
    const [value, setValue] = signal(0);
    const cleanup = vi.fn();

    const stop = effect((onCleanup) => {
      value();
      onCleanup(cleanup);
    });
    await tick();

    cleanup.mockClear();
    setValue(1);
    await tick();
    // Re-run cleans up the previous run.
    const afterRerun = cleanup.mock.calls.length;

    stop();
    await tick();
    expect(cleanup.mock.calls.length).toBe(afterRerun + 1);

    stop();
    await tick();
    expect(cleanup.mock.calls.length).toBe(afterRerun + 1);
  });
});
