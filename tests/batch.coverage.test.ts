import { describe, expect, it, vi } from "vitest";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { batch, enqueueBatchedSignal, isBatching } from "../src/reactivity/batch";

describe("batch — return value & control flow", () => {
  it("returns the value produced by the batched function", () => {
    const result = batch(() => "done");
    expect(result).toBe("done");
  });

  it("returns undefined for a void body", () => {
    const result = batch(() => {});
    expect(result).toBeUndefined();
  });

  it("returns the value even after deferred state updates", () => {
    const [, setN] = signal(0);
    const result = batch(() => {
      setN(1);
      setN(2);
      return 99;
    });
    expect(result).toBe(99);
  });

  it("propagates exceptions thrown inside the body", () => {
    expect(() =>
      batch(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
  });

  it("still flushes pending updates when the body throws", () => {
    const [n, setN] = signal(0);
    let seen = 0;
    effect(() => {
      seen = n();
    });

    expect(() =>
      batch(() => {
        setN(7);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // The throw unwinds through the finally, which decrements depth to 0 and
    // flushes — so the subscriber sees the committed value.
    expect(n()).toBe(7);
    expect(seen).toBe(7);
  });
});

describe("batch — deduping & dedup of subscribers", () => {
  it("notifies a subscriber once when multiple signals it depends on change", () => {
    const [a, setA] = signal(1);
    const [b, setB] = signal(2);
    const spy = vi.fn();
    effect(() => {
      a();
      b();
      spy();
    });
    expect(spy).toHaveBeenCalledTimes(1);

    batch(() => {
      setA(10);
      setB(20);
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("notifies once even when the SAME signal is written multiple times", () => {
    const [n, setN] = signal(0);
    const spy = vi.fn();
    effect(() => {
      n();
      spy();
    });
    expect(spy).toHaveBeenCalledTimes(1);

    batch(() => {
      setN(1);
      setN(2);
      setN(3);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(n()).toBe(3);
  });

  it("only the final value is observed by subscribers after the batch", () => {
    const [n, setN] = signal(0);
    const seen: number[] = [];
    effect(() => {
      seen.push(n());
    });
    batch(() => {
      setN(1);
      setN(2);
      setN(3);
    });
    // First the initial 0, then a single notification carrying the latest value.
    expect(seen).toEqual([0, 3]);
  });

  it("two independent subscribers each fire once", () => {
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    const spyA = vi.fn();
    const spyB = vi.fn();
    effect(() => {
      a();
      spyA();
    });
    effect(() => {
      b();
      spyB();
    });

    batch(() => {
      setA(1);
      setB(1);
    });
    expect(spyA).toHaveBeenCalledTimes(2);
    expect(spyB).toHaveBeenCalledTimes(2);
  });
});

describe("batch — nesting", () => {
  it("only the outermost batch flushes notifications", () => {
    const [x, setX] = signal(0);
    const spy = vi.fn();
    effect(() => {
      x();
      spy();
    });
    expect(spy).toHaveBeenCalledTimes(1);

    batch(() => {
      batch(() => {
        setX(1);
      });
      // Inner batch did NOT flush yet — still inside the outer batch.
      expect(spy).toHaveBeenCalledTimes(1);
      setX(2);
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(x()).toBe(2);
  });

  it("supports deeply nested batches (3 levels)", () => {
    const [n, setN] = signal(0);
    const spy = vi.fn();
    effect(() => {
      n();
      spy();
    });

    batch(() => {
      batch(() => {
        batch(() => {
          setN(1);
        });
        setN(2);
      });
      setN(3);
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(n()).toBe(3);
  });

  it("nested batch returns its own body value", () => {
    const outer = batch(() => {
      const inner = batch(() => 5);
      return inner + 1;
    });
    expect(outer).toBe(6);
  });
});

describe("batch — computed propagation", () => {
  it("derived values recompute and notify once after a batch", () => {
    const [a, setA] = signal(1);
    const [b, setB] = signal(1);
    const sum = derived(() => a() + b());

    const spy = vi.fn();
    effect(() => {
      sum();
      spy();
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sum()).toBe(2);

    batch(() => {
      setA(10);
      setB(20);
    });

    expect(sum()).toBe(30);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("isBatching", () => {
  it("is false outside any batch", () => {
    expect(isBatching()).toBe(false);
  });

  it("is true inside a batch", () => {
    let inside = false;
    batch(() => {
      inside = isBatching();
    });
    expect(inside).toBe(true);
  });

  it("remains true inside nested batches and false again afterwards", () => {
    const observed: boolean[] = [];
    batch(() => {
      observed.push(isBatching());
      batch(() => {
        observed.push(isBatching());
      });
      observed.push(isBatching());
    });
    observed.push(isBatching());
    expect(observed).toEqual([true, true, true, false]);
  });

  it("returns to false even if the body throws", () => {
    try {
      batch(() => {
        throw new Error("x");
      });
    } catch {
      /* ignore */
    }
    expect(isBatching()).toBe(false);
  });
});

describe("enqueueBatchedSignal", () => {
  it("returns false when not inside a batch (caller notifies immediately)", () => {
    const [n] = signal(0);
    const sig = (n as unknown as { __signal: unknown }).__signal;
    expect(enqueueBatchedSignal(sig as never)).toBe(false);
  });

  it("returns true when inside a batch (notification deferred)", () => {
    const [n] = signal(0);
    const sig = (n as unknown as { __signal: unknown }).__signal;
    let queued: boolean | undefined;
    batch(() => {
      queued = enqueueBatchedSignal(sig as never);
    });
    expect(queued).toBe(true);
  });
});

describe("batch — immediate notification when not batching", () => {
  it("notifies synchronously outside a batch", () => {
    const [val, setVal] = signal("a");
    let lastSeen = "";
    effect(() => {
      lastSeen = val();
    });
    expect(lastSeen).toBe("a");
    setVal("b");
    expect(lastSeen).toBe("b");
  });
});
