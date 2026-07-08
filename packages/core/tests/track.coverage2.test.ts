import { afterEach, describe, expect, it, vi } from "vitest";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import {
  cleanup,
  forEachSubscriber,
  getSubscriberCount,
  getSubscriberDeps,
  reactiveBinding,
  recordDependency,
  resumeTracking,
  setMaxDrainIterations,
  setMaxSubscriberRepeats,
  suspendTracking,
  track,
  untracked,
} from "../src/reactivity/track";

describe("track coverage2 — suspend/resume/untracked", () => {
  it("untracked prevents dependency registration", () => {
    const [n, setN] = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy();
      untracked(() => n());
    });
    expect(spy).toHaveBeenCalledTimes(1);
    setN(1);
    expect(spy).toHaveBeenCalledTimes(1); // not tracked
  });

  it("nested suspend/resume only restores at depth 0", () => {
    const [n, setN] = signal(0);
    const spy = vi.fn();
    effect(() => {
      spy();
      suspendTracking();
      suspendTracking();
      n(); // suspended
      resumeTracking();
      n(); // still suspended (depth 1)
      resumeTracking();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    setN(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("recordDependency outside a tracking context is a no-op", () => {
    const [n] = signal(0);
    const sig = (n as any).__signal ?? (n as any);
    // Calling without a current subscriber must not throw
    expect(() => recordDependency(sig)).not.toThrow();
  });
});

describe("track coverage2 — devtools helpers", () => {
  it("getSubscriberCount reflects live subscribers", () => {
    const [n, setN] = signal(0);
    const sig = (n as any).__signal;
    expect(getSubscriberCount(sig)).toBe(0);
    const dispose = effect(() => n());
    expect(getSubscriberCount(sig)).toBe(1);
    dispose();
    expect(getSubscriberCount(sig)).toBe(0);
    setN(1);
  });

  it("getSubscriberDeps returns signals a subscriber depends on", () => {
    const [a] = signal(1);
    const [b] = signal(2);
    const sub = () => {};
    const dispose = track(() => {
      a();
      b();
    }, sub);
    const deps = getSubscriberDeps(sub);
    expect(deps.length).toBe(2);
    dispose();
  });

  it("forEachSubscriber visits each subscriber of a signal", () => {
    const [n] = signal(0);
    const sig = (n as any).__signal;
    const d1 = effect(() => n());
    const d2 = effect(() => n());
    const visited: unknown[] = [];
    forEachSubscriber(sig, (s) => visited.push(s));
    expect(visited.length).toBe(2);
    d1();
    d2();
  });
});

describe("track coverage2 — cycle & drain limits", () => {
  afterEach(() => {
    setMaxSubscriberRepeats(50);
    setMaxDrainIterations(1_000_000);
  });

  it("setMaxSubscriberRepeats returns prior value and rejects bad input", () => {
    const prev = setMaxSubscriberRepeats(10);
    expect(typeof prev).toBe("number");
    const noChange = setMaxSubscriberRepeats(-5); // invalid → ignored
    expect(noChange).toBe(10);
    expect(setMaxSubscriberRepeats(Number.NaN)).toBe(10);
  });

  it("setMaxDrainIterations returns prior value and rejects bad input", () => {
    const prev = setMaxDrainIterations(500);
    expect(typeof prev).toBe("number");
    expect(setMaxDrainIterations(0)).toBe(500); // invalid → ignored
  });

  it("breaks a write-reads-self cycle between two effects and logs", () => {
    setMaxSubscriberRepeats(5);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    effect(() => {
      const av = a();
      setB(av + 1);
    });
    effect(() => {
      const bv = b();
      setA(bv + 1);
    });
    setA(1); // kick the cycle
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("trips the absolute drain iteration cap", () => {
    setMaxDrainIterations(3);
    setMaxSubscriberRepeats(1_000_000);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    effect(() => {
      const av = a();
      if (av < 100) setB(av + 1);
    });
    effect(() => {
      const bv = b();
      if (bv < 100) setA(bv + 1);
    });
    setA(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("track coverage2 — cleanup & safeInvoke", () => {
  it("cleanup tears down all edges of a subscriber", () => {
    const [n, setN] = signal(0);
    const spy = vi.fn();
    const sub = () => {
      n();
      spy();
    };
    track(sub, sub);
    expect(spy).toHaveBeenCalledTimes(1);
    cleanup(sub);
    setN(1);
    expect(spy).toHaveBeenCalledTimes(1); // no longer reactive (no re-run scheduled)
  });

  it("a throwing subscriber is caught during notification (safeInvoke)", () => {
    const [n, setN] = signal(0);
    // reactiveBinding uses retrack; a throwing commit during a notify-driven
    // run should be swallowed by safeInvoke without breaking the drain.
    let runs = 0;
    reactiveBinding(() => {
      n();
      runs++;
      if (runs > 1) throw new Error("commit boom");
    });
    expect(() => setN(1)).not.toThrow();
  });
});

describe("track coverage2 — propagateDirty nested computed & diamond", () => {
  it("propagates dirtiness through a chain of computeds", async () => {
    const { derived } = await import("../src/core/signals/derived");
    const [n, setN] = signal(1);
    const d1 = derived(() => n() * 2);
    const d2 = derived(() => d1() + 1);
    const spy = vi.fn();
    effect(() => {
      d2();
      spy();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    setN(5); // n → d1 → d2 → effect (nested computed walk)
    expect(spy).toHaveBeenCalledTimes(2);
    expect(d2()).toBe(11);
  });

  it("dedups a computed reached by multiple diamond paths", async () => {
    const { derived } = await import("../src/core/signals/derived");
    const [n, setN] = signal(1);
    const left = derived(() => n() + 1);
    const right = derived(() => n() + 2);
    // sink reached via both left and right (diamond), and depends on n's chain
    const sink = derived(() => left() + right());
    const spy = vi.fn();
    effect(() => {
      sink();
      spy();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    setN(10);
    expect(sink()).toBe(23); // 11 + 12
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("track coverage2 — batched notification through computeds", () => {
  it("queueSignalNotification propagates a computed dep inside a batch", async () => {
    const { derived } = await import("../src/core/signals/derived");
    const { batch } = await import("../src/reactivity/batch");
    const [a, setA] = signal(1);
    const [b, setB] = signal(1);
    const sum = derived(() => a() + b());
    const spy = vi.fn();
    effect(() => {
      sum();
      spy();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    batch(() => {
      setA(10);
      setB(20);
    });
    expect(sum()).toBe(30);
    expect(spy).toHaveBeenCalledTimes(2); // single drain despite two writes
  });

  it("batched plain-signal effect enqueues once", () => {
    const [a, setA] = signal(1);
    const spy = vi.fn();
    effect(() => {
      a();
      spy();
    });
    return import("../src/reactivity/batch").then(({ batch }) => {
      batch(() => {
        setA(2);
        setA(3);
        setA(4);
      });
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});

describe("track coverage2 — explicit subscriber track()", () => {
  it("track with explicit subscriber registers deps and returns cached disposer", () => {
    const [n, setN] = signal(0);
    const sub = vi.fn();
    const body = () => {
      n();
    };
    const dispose1 = track(body, sub);
    const dispose2 = track(body, sub);
    expect(dispose1).toBe(dispose2); // cached
    dispose1();
    setN(1);
  });
});
