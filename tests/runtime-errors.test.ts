import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeErrorHandler,
  type RuntimeErrorContext,
  reportError,
  setRuntimeErrorHandler,
} from "../src/core/errors";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { reactiveBinding } from "../src/reactivity/track";

// ---------------------------------------------------------------------------
// Runtime error observability.
//
// THE INVARIANT UNDER TEST: containment is not silence. The runtime must keep
// one broken subscriber from aborting unrelated work, and must NOT thereby turn
// "the application threw" into "nothing happened".
//
// Regression origin: the drain's catch only warned when a dev-mode flag was on,
// so in production an exception from an effect RE-RUN vanished completely,
// while the same exception on the INITIAL run propagated to the caller.
// ---------------------------------------------------------------------------

afterEach(() => {
  setRuntimeErrorHandler(null);
});

describe("runtime error pipeline", () => {
  it("routes contained errors to a configured handler", () => {
    const seen: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
    setRuntimeErrorHandler((error, context) => seen.push({ error, context }));

    const [count, setCount] = signal(0);
    const dispose = effect(() => {
      if (count() === 1) throw new Error("boom-rerun");
    });

    setCount(1);

    expect(seen).toHaveLength(1);
    expect((seen[0].error as Error).message).toBe("boom-rerun");
    expect(seen[0].context.phase).toBe("effect");
    dispose();
  });

  it("falls back to console.error when no handler is installed", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const [count, setCount] = signal(0);
    const dispose = effect(() => {
      if (count() === 1) throw new Error("visible-in-production");
    });

    setCount(1);

    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("visible-in-production");
    errSpy.mockRestore();
    dispose();
  });

  it("reports the original error even when the handler itself throws", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setRuntimeErrorHandler(() => {
      throw new Error("handler is broken");
    });

    reportError(new Error("original failure"), { phase: "effect" });

    const joined = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("handler is broken");
    expect(joined).toContain("original failure");
    errSpy.mockRestore();
  });

  it("restores the previous handler when replaced", () => {
    const first = vi.fn();
    const prevNull = setRuntimeErrorHandler(first);
    expect(prevNull).toBeNull();

    const second = vi.fn();
    const prev = setRuntimeErrorHandler(second);
    expect(prev).toBe(first);

    reportError(new Error("x"), { phase: "render" });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("never throws out of reportError", () => {
    expect(() => reportError(new Error("safe"), { phase: "scheduler" })).not.toThrow();
    expect(() => reportError("a non-error value", { phase: "async" })).not.toThrow();
  });

  it("exposes the installed handler via getRuntimeErrorHandler", () => {
    expect(getRuntimeErrorHandler()).toBeNull();
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);
    expect(getRuntimeErrorHandler()).toBe(handler);
    setRuntimeErrorHandler(null);
    expect(getRuntimeErrorHandler()).toBeNull();
  });

  it("includes the debug name in the default report when one is given", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    reportError(new Error("named failure"), { phase: "derived", name: "totals" });
    const joined = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("totals");
    expect(joined).toContain("derived");
    errSpy.mockRestore();
  });
});

describe("error boundary routing", () => {
  it("offers the error to a listener but does NOT treat dispatch as handling", () => {
    // A listener that observes the event without claiming it has not handled
    // anything. Returning here merely because a dispatch occurred is what made
    // errors vanish whenever a node existed but no boundary was mounted.
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);

    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);
    document.body.appendChild(parent);

    const caught: unknown[] = [];
    parent.addEventListener("sibu:error-propagate", (event) => {
      caught.push((event as CustomEvent).detail.error);
    });

    reportError(new Error("boundary-bound"), { phase: "render", node: child });

    expect(caught).toHaveLength(1);
    expect((caught[0] as Error).message).toBe("boundary-bound");
    // Nobody claimed it, so the fallback chain must still run — exactly once.
    expect(handler).toHaveBeenCalledTimes(1);
    parent.remove();
  });

  it("stops at a listener that explicitly claims the error", () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);

    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);
    document.body.appendChild(parent);

    parent.addEventListener("sibu:error-propagate", (event) => {
      // preventDefault() is the acknowledgement contract.
      event.preventDefault();
    });

    reportError(new Error("claimed"), { phase: "render", node: child });

    expect(handler).not.toHaveBeenCalled();
    parent.remove();
  });

  it("carries the context alongside the error in the event detail", () => {
    const seen: Array<{ phase: string; name?: string }> = [];
    const el = document.createElement("div");
    document.body.appendChild(el);
    el.addEventListener("sibu:error-propagate", (event) => {
      const detail = (event as CustomEvent).detail;
      seen.push(detail.context);
      event.preventDefault();
    });

    reportError(new Error("with-context"), { phase: "render", name: "widget", node: el });

    expect(seen).toHaveLength(1);
    expect(seen[0].phase).toBe("render");
    expect(seen[0].name).toBe("widget");
    el.remove();
  });

  it("wraps a non-Error value before dispatching to a boundary", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const caught: unknown[] = [];
    el.addEventListener("sibu:error-propagate", (event) => {
      caught.push((event as CustomEvent).detail.error);
    });

    reportError("just a string", { phase: "event", node: el });

    expect(caught[0]).toBeInstanceOf(Error);
    expect((caught[0] as Error).message).toBe("just a string");
    el.remove();
  });

  it("falls through to reporting when dispatch itself fails", () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);
    const hostile = {
      dispatchEvent() {
        throw new Error("hostile node");
      },
    };

    reportError(new Error("still reported"), { phase: "render", node: hostile });

    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as Error).message).toBe("still reported");
  });

  it("ignores a context node that cannot dispatch", () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);
    reportError(new Error("plain object node"), { phase: "render", node: {} });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("a derived whose getter throws", () => {
  it("lets the failure surface at the subscriber rather than in the scheduler", () => {
    const seen: string[] = [];
    setRuntimeErrorHandler((error) => seen.push((error as Error).message));

    const [n, setN] = signal(0);
    const risky = derived(() => {
      if (n() === 1) throw new Error("derived boom");
      return n();
    });

    let runs = 0;
    const dispose = effect(() => {
      risky();
      runs++;
    });
    expect(runs).toBe(1);

    // Validation during the drain throws; the subscriber is still run so the
    // error is attributed to the effect that reads it, not swallowed.
    setN(1);
    expect(seen.join("\n")).toContain("derived boom");

    // The graph recovers once the getter stops throwing.
    setN(2);
    expect(risky()).toBe(2);
    dispose();
  });
});

describe("initial vs rerun error policy", () => {
  it("surfaces an initial-run error synchronously to the caller", () => {
    const [count] = signal(1);
    // The initial run has a caller that can receive the throw, so it
    // propagates — failing fast at setup.
    expect(() =>
      effect(() => {
        if (count() === 1) throw new Error("boom-initial");
      }),
    ).toThrow("boom-initial");
  });

  it("makes a rerun error observable through the same pipeline", () => {
    const seen: string[] = [];
    setRuntimeErrorHandler((error) => seen.push((error as Error).message));

    const [count, setCount] = signal(0);
    const dispose = effect(() => {
      if (count() === 1) throw new Error("boom-rerun");
    });
    setCount(1);

    expect(seen).toEqual(["boom-rerun"]);
    dispose();
  });

  it("routes both phases to onError when the effect declares one", () => {
    const seen: string[] = [];
    const [count, setCount] = signal(1);

    const dispose = effect(
      () => {
        if (count() >= 1) throw new Error(`boom-${count()}`);
      },
      { onError: (err) => seen.push((err as Error).message) },
    );

    expect(seen).toEqual(["boom-1"]); // initial
    setCount(2);
    expect(seen).toEqual(["boom-1", "boom-2"]); // rerun — same channel
    dispose();
  });

  it("a throwing subscriber does not abort the drain for its siblings", () => {
    setRuntimeErrorHandler(() => {});
    const [n, setN] = signal(0);
    let goodRuns = 0;

    // Subscribed first, so it is notified after the thrower under the
    // most-recent-first firing order.
    const good = effect(() => {
      n();
      goodRuns++;
    });
    const bad = effect(() => {
      if (n() === 1) throw new Error("sibling boom");
    });

    const baseline = goodRuns;
    setN(1);

    expect(goodRuns).toBe(baseline + 1);
    good();
    bad();
  });

  it("contains a throwing reactive binding without breaking reactivity", () => {
    setRuntimeErrorHandler(() => {});
    const [n, setN] = signal(0);
    let runs = 0;
    reactiveBinding(() => {
      n();
      runs++;
      if (runs === 2) throw new Error("commit boom");
    });

    expect(() => setN(1)).not.toThrow();
    expect(runs).toBe(2);
    // The binding must still be alive after containing the throw.
    setN(2);
    expect(runs).toBe(3);
  });
});

describe("cleanup error isolation", () => {
  it("runs every sibling cleanup when one throws, and reports the failure", () => {
    const seen: string[] = [];
    setRuntimeErrorHandler((error) => seen.push((error as Error).message));

    const order: string[] = [];
    const dispose = effect((onCleanup) => {
      onCleanup(() => order.push("A"));
      onCleanup(() => {
        order.push("B");
        throw new Error("cleanup B failed");
      });
      onCleanup(() => order.push("C"));
    });

    dispose();

    // Cleanups run in reverse registration order; B throwing must not strand
    // A — the cleanup registered before it — nor C, registered after.
    expect(order).toEqual(["C", "B", "A"]);
    expect(seen).toEqual(["cleanup B failed"]);
  });

  it("continues when several cleanups throw", () => {
    const seen: string[] = [];
    setRuntimeErrorHandler((error) => seen.push((error as Error).message));

    const order: string[] = [];
    const dispose = effect((onCleanup) => {
      onCleanup(() => {
        order.push("A");
        throw new Error("A failed");
      });
      onCleanup(() => {
        order.push("B");
        throw new Error("B failed");
      });
    });

    expect(() => dispose()).not.toThrow();
    expect(order).toEqual(["B", "A"]);
    expect(seen).toEqual(["B failed", "A failed"]);
  });

  it("dispose remains idempotent after a throwing cleanup", () => {
    setRuntimeErrorHandler(() => {});
    let runs = 0;
    const dispose = effect((onCleanup) => {
      onCleanup(() => {
        runs++;
        throw new Error("nope");
      });
    });

    dispose();
    dispose();
    expect(runs).toBe(1);
  });
});
