import { afterEach, describe, expect, it, vi } from "vitest";
import { reportError, setRuntimeErrorHandler } from "../src/core/errors";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { getSubscriberCount, reactiveBinding, setMaxSubscriberRepeats } from "../src/reactivity/track";

// ---------------------------------------------------------------------------
// Phase accuracy, thrown-value normalization, safety-ceiling observability and
// handler recursion bounds.
//
// A public phase enum that cannot be trusted is worse than no phase at all, so
// each producer is pinned to the phase it actually represents. Before this
// pass, every subscriber exception was labelled "effect" because the drain
// invokes effects and DOM bindings through the same call.
// ---------------------------------------------------------------------------

afterEach(() => {
  setRuntimeErrorHandler(null);
  vi.restoreAllMocks();
});

function capture(): Array<{ phase: string; name?: string }> {
  const contexts: Array<{ phase: string; name?: string }> = [];
  setRuntimeErrorHandler((_error, context) => contexts.push(context));
  return contexts;
}

describe("error phases are accurate", () => {
  it('an effect body reports phase "effect"', () => {
    const contexts = capture();
    const [n, setN] = signal(0);
    const dispose = effect(() => {
      if (n() === 1) throw new Error("effect phase");
    });
    setN(1);
    expect(contexts.map((c) => c.phase)).toEqual(["effect"]);
    dispose();
  });

  it('a reactive binding reports phase "binding", not "effect"', () => {
    const contexts = capture();
    const [n, setN] = signal(0);
    let runs = 0;
    const dispose = reactiveBinding(() => {
      const v = n();
      runs++;
      if (v === 1) throw new Error("binding phase");
    });
    expect(runs).toBe(1);
    setN(1);
    expect(contexts.map((c) => c.phase)).toEqual(["binding"]);
    dispose();
  });

  it('a cleanup reports phase "cleanup"', () => {
    const contexts = capture();
    const dispose = effect((onCleanup) => {
      onCleanup(() => {
        throw new Error("cleanup phase");
      });
    });
    dispose();
    expect(contexts.map((c) => c.phase)).toEqual(["cleanup"]);
  });

  it('a scheduler safety ceiling reports phase "scheduler"', () => {
    const contexts = capture();
    const prev = setMaxSubscriberRepeats(5);
    try {
      const [a, setA] = signal(0);
      const [b, setB] = signal(0);
      const dA = effect(() => {
        setB(a() + 1);
      });
      const dB = effect(() => {
        setA(b() + 1);
      });
      setA(1);
      expect(contexts.some((c) => c.phase === "scheduler")).toBe(true);
      dA();
      dB();
    } finally {
      setMaxSubscriberRepeats(prev);
    }
  });
});

describe("non-Error thrown values stay observable", () => {
  it("wraps a thrown string and preserves it as cause", () => {
    const seen: unknown[] = [];
    setRuntimeErrorHandler((error) => seen.push(error));
    const [n, setN] = signal(0);
    const dispose = effect(() => {
      if (n() === 1) throw "a bare string";
    });
    setN(1);

    expect(seen).toHaveLength(1);
    const received = seen[0] as Error;
    expect(received).toBeInstanceOf(Error);
    expect(received.message).toBe("a bare string");
    expect(received.cause).toBe("a bare string");
    dispose();
  });

  it("wraps thrown null / numbers / objects without losing the value", () => {
    const seen: Error[] = [];
    setRuntimeErrorHandler((error) => seen.push(error as Error));

    reportError(null, { phase: "effect" });
    reportError(42, { phase: "effect" });
    reportError({ problem: true }, { phase: "effect" });

    expect(seen).toHaveLength(3);
    expect(seen[0].cause).toBeNull();
    expect(seen[1].cause).toBe(42);
    expect(seen[2].cause).toEqual({ problem: true });
    // The message stays useful rather than collapsing to "[object Object]".
    expect(seen[2].message).toContain("problem");
  });

  it("passes an existing Error through by reference", () => {
    const seen: unknown[] = [];
    setRuntimeErrorHandler((error) => seen.push(error));
    class CustomError extends Error {
      code = "E_CUSTOM";
    }
    const original = new CustomError("keep identity");

    reportError(original, { phase: "effect" });

    // Identity matters for telemetry, instanceof checks and custom fields.
    expect(seen[0]).toBe(original);
    expect((seen[0] as CustomError).code).toBe("E_CUSTOM");
  });
});

describe("safety ceilings are not gated on developer warnings", () => {
  it("reports an effect rerun cap even when __SIBU_DEV_WARN__ is false", () => {
    const g = globalThis as Record<string, unknown>;
    const previous = g.__SIBU_DEV_WARN__;
    g.__SIBU_DEV_WARN__ = false;
    try {
      const seen: string[] = [];
      setRuntimeErrorHandler((error) => seen.push((error as Error).message));

      const [n, setN] = signal(0);
      // Never stabilizes, so the framework forcibly stops it. That is a
      // contained runtime FAILURE, not an optional diagnostic — silencing
      // developer warnings must not silence it.
      const dispose = effect(() => {
        setN(n() + 1);
      });

      expect(seen.join("\n")).toContain("re-requested itself");
      dispose();
    } finally {
      if (previous === undefined) delete g.__SIBU_DEV_WARN__;
      else g.__SIBU_DEV_WARN__ = previous;
    }
  });

  it("reports the rerun cap exactly once per incident", () => {
    const seen: string[] = [];
    setRuntimeErrorHandler((error) => seen.push((error as Error).message));
    const [n, setN] = signal(0);
    const dispose = effect(() => {
      setN(n() + 1);
    });
    expect(seen.filter((m) => m.includes("re-requested itself"))).toHaveLength(1);
    dispose();
  });
});

describe("handler recursion is bounded", () => {
  it("a handler that reports again does not recurse forever", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let depth = 0;
    setRuntimeErrorHandler(() => {
      depth++;
      // Deliberately re-enters the pipeline from inside the handler.
      reportError(new Error("nested from handler"), { phase: "effect" });
    });

    expect(() => reportError(new Error("outer"), { phase: "effect" })).not.toThrow();
    // The handler runs for the outer error only; the nested report falls
    // through to the console instead of re-entering the handler.
    expect(depth).toBe(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("nested from handler");
    errSpy.mockRestore();
  });

  it("a handler that always throws terminates and still reports the original", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setRuntimeErrorHandler(() => {
      throw new Error("handler always fails");
    });

    expect(() => reportError(new Error("original survives"), { phase: "effect" })).not.toThrow();
    const joined = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("handler always fails");
    expect(joined).toContain("original survives");
    errSpy.mockRestore();
  });

  it("the guard is not sticky — the handler works again on the next report", () => {
    const seen: string[] = [];
    setRuntimeErrorHandler((error) => seen.push((error as Error).message));

    reportError(new Error("first"), { phase: "effect" });
    reportError(new Error("second"), { phase: "effect" });

    expect(seen).toEqual(["first", "second"]);
  });

  it("a handler that writes signals does not corrupt the scheduler", () => {
    const [count, setCount] = signal(0);
    setRuntimeErrorHandler(() => {
      setCount((c) => c + 1);
    });

    const [n, setN] = signal(0);
    const dispose = effect(() => {
      if (n() === 1) throw new Error("triggers handler write");
    });
    setN(1);

    expect(count()).toBe(1);
    // The scheduler is still usable afterwards.
    const [m, setM] = signal(0);
    let observed = 0;
    const d2 = effect(() => {
      observed = m();
    });
    setM(7);
    expect(observed).toBe(7);
    dispose();
    d2();
  });

  it("reporting does not subscribe the failing subscriber to signals the handler reads", () => {
    // A handler — or an ErrorBoundary listener — that READS a signal must not
    // have that read attributed to whatever subscriber was mid-run when it
    // threw. That leak made a failing binding a subscriber of the boundary's
    // own error signal, so it re-ran and reported the same failure twice.
    const [tracked] = signal("watched");
    setRuntimeErrorHandler(() => {
      tracked();
    });

    const [n, setN] = signal(0);
    let runs = 0;
    const dispose = effect(() => {
      runs++;
      if (n() === 1) throw new Error("boom");
    });

    setN(1);
    const runsAfterError = runs;
    expect(getSubscriberCount((tracked as unknown as { __signal: object }).__signal as never)).toBe(0);
    expect(runs).toBe(runsAfterError);
    dispose();
  });
});
