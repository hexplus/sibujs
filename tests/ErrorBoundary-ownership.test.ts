import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { div } from "../src/core/rendering/html";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// ErrorBoundary ownership.
//
// THE INVARIANT UNDER TEST: configuration may be shared; FAILURE STATE MAY NOT.
//
// A `fallback` function is configuration — sharing one across an application is
// the intended, idiomatic use. But the Error object, the retry callback and the
// rendered fallback belong to ONE boundary instance and must never be reachable
// from another.
//
// Regression origin: fallbacks were memoized in a module-global
// `WeakMap<fallbackFn, Map<error.message, factory>>`, and the cached factory
// closed over the specific Error AND the specific boundary's `retry`. Two
// sibling boundaries sharing one fallback function whose errors happened to
// carry the same message therefore aliased each other: B's fallback could be
// handed A's Error and A's retry. `retry()` compounded it by deleting the
// shared cache entry by message, invalidating the OTHER boundary's state.
//
// Two errors having the same human-readable message does not make them the
// same failure.
// ---------------------------------------------------------------------------

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

let host: HTMLElement | null = null;

function mount(...nodes: Node[]): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  for (const n of nodes) container.appendChild(n);
  host = container;
  return container;
}

afterEach(() => {
  setRuntimeErrorHandler(null);
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

/** Records exactly which Error object and which retry each render received. */
interface FallbackCall {
  error: Error;
  retry: () => void;
}

function makeSharedFallback(calls: FallbackCall[]) {
  // ONE function instance, deliberately shared by every boundary below.
  return (error: Error, retry: () => void): Element => {
    calls.push({ error, retry });
    const el = div({ class: "shared-fb" });
    el.setAttribute("data-error-id", String((error as Error & { errorId?: string }).errorId ?? "?"));
    return el as Element;
  };
}

/** A boundary whose child throws the supplied error on demand. */
function makeBoundary(sharedFallback: (e: Error, r: () => void) => Element, err: Error) {
  const [fail, setFail] = signal(false);
  const node = ErrorBoundary({ fallback: sharedFallback }, () =>
    div({
      nodes: () => {
        if (fail()) throw err;
        return "ok";
      },
    }),
  );
  return { node, trigger: () => setFail(true), reset: () => setFail(false) };
}

describe("two boundaries sharing one fallback function", () => {
  it("each fallback receives its OWN Error object, not an alias by message", async () => {
    const calls: FallbackCall[] = [];
    const sharedFallback = makeSharedFallback(calls);

    // Same message, different instances, different custom fields.
    const errorA = Object.assign(new Error("Load failed"), { errorId: "A" });
    const errorB = Object.assign(new Error("Load failed"), { errorId: "B" });
    expect(errorA).not.toBe(errorB);
    expect(errorA.message).toBe(errorB.message);

    const a = makeBoundary(sharedFallback, errorA);
    const b = makeBoundary(sharedFallback, errorB);
    const container = mount(a.node, b.node);
    await flush();

    a.trigger();
    await flush();
    b.trigger();
    await flush();

    const forA = calls.find((c) => (c.error as Error & { errorId?: string }).errorId === "A");
    const forB = calls.find((c) => (c.error as Error & { errorId?: string }).errorId === "B");
    expect(forA?.error).toBe(errorA);
    expect(forB?.error).toBe(errorB);

    // And the DOM each boundary rendered carries its own identity.
    const ids = Array.from(container.querySelectorAll(".shared-fb")).map((el) => el.getAttribute("data-error-id"));
    expect(ids).toEqual(["A", "B"]);
  });

  it("preserves Error subclass identity and custom fields", async () => {
    class LoadError extends Error {
      code = "LOAD_FAILED";
    }
    const calls: FallbackCall[] = [];
    const sharedFallback = makeSharedFallback(calls);

    const plain = Object.assign(new Error("Load failed"), { errorId: "plain" });
    const custom = Object.assign(new LoadError("Load failed"), { errorId: "custom" });

    const a = makeBoundary(sharedFallback, plain);
    const b = makeBoundary(sharedFallback, custom);
    mount(a.node, b.node);
    await flush();

    a.trigger();
    await flush();
    b.trigger();
    await flush();

    const forB = calls.find((c) => (c.error as Error & { errorId?: string }).errorId === "custom");
    expect(forB?.error).toBeInstanceOf(LoadError);
    expect((forB?.error as LoadError).code).toBe("LOAD_FAILED");
  });

  it("each fallback receives its OWN retry callback", async () => {
    const calls: FallbackCall[] = [];
    const sharedFallback = makeSharedFallback(calls);

    const errorA = Object.assign(new Error("Load failed"), { errorId: "A" });
    const errorB = Object.assign(new Error("Load failed"), { errorId: "B" });

    const a = makeBoundary(sharedFallback, errorA);
    const b = makeBoundary(sharedFallback, errorB);
    const container = mount(a.node, b.node);
    await flush();

    a.trigger();
    await flush();
    b.trigger();
    await flush();

    expect(container.querySelectorAll(".shared-fb")).toHaveLength(2);

    const forB = calls.find((c) => (c.error as Error & { errorId?: string }).errorId === "B");
    // Stop B's child from throwing, then invoke B's OWN retry.
    b.reset();
    forB?.retry();
    await flush();

    const remaining = Array.from(container.querySelectorAll(".shared-fb")).map((el) =>
      el.getAttribute("data-error-id"),
    );
    // B recovered; A is untouched and still showing its own fallback.
    expect(remaining).toEqual(["A"]);
  });

  it("retrying A does not reset B", async () => {
    const calls: FallbackCall[] = [];
    const sharedFallback = makeSharedFallback(calls);

    const errorA = Object.assign(new Error("Load failed"), { errorId: "A" });
    const errorB = Object.assign(new Error("Load failed"), { errorId: "B" });

    const a = makeBoundary(sharedFallback, errorA);
    const b = makeBoundary(sharedFallback, errorB);
    const container = mount(a.node, b.node);
    await flush();

    a.trigger();
    await flush();
    b.trigger();
    await flush();

    const forA = calls.find((c) => (c.error as Error & { errorId?: string }).errorId === "A");
    a.reset();
    forA?.retry();
    await flush();

    const remaining = Array.from(container.querySelectorAll(".shared-fb")).map((el) =>
      el.getAttribute("data-error-id"),
    );
    expect(remaining).toEqual(["B"]);
  });

  it("a boundary can fail, retry, and fail again with a fresh Error", async () => {
    const calls: FallbackCall[] = [];
    const sharedFallback = makeSharedFallback(calls);

    const [which, setWhich] = signal(0);
    const first = Object.assign(new Error("Load failed"), { errorId: "first" });
    const second = Object.assign(new Error("Load failed"), { errorId: "second" });

    const node = ErrorBoundary({ fallback: sharedFallback }, () =>
      div({
        nodes: () => {
          const w = which();
          if (w === 1) throw first;
          if (w === 2) throw second;
          return "ok";
        },
      }),
    );
    const container = mount(node);
    await flush();

    setWhich(1);
    await flush();
    expect(container.querySelector(".shared-fb")?.getAttribute("data-error-id")).toBe("first");

    // Recover, then fail again with a DIFFERENT Error carrying the SAME message.
    const firstCall = calls.at(-1);
    setWhich(0);
    firstCall?.retry();
    await flush();

    setWhich(2);
    await flush();
    expect(container.querySelector(".shared-fb")?.getAttribute("data-error-id")).toBe("second");
    expect(calls.at(-1)?.error).toBe(second);
  });
});

describe("nested boundaries sharing one fallback function", () => {
  it("the inner boundary owns its own error and retry", async () => {
    const calls: FallbackCall[] = [];
    const sharedFallback = makeSharedFallback(calls);
    const innerError = Object.assign(new Error("Load failed"), { errorId: "inner" });

    const [fail, setFail] = signal(false);
    const tree = ErrorBoundary({ fallback: sharedFallback }, () =>
      ErrorBoundary({ fallback: sharedFallback }, () =>
        div({
          nodes: () => {
            if (fail()) throw innerError;
            return "ok";
          },
        }),
      ),
    );
    const container = mount(tree);
    await flush();

    setFail(true);
    await flush();

    // Only the inner boundary rendered a fallback, with its own error.
    const rendered = Array.from(container.querySelectorAll(".shared-fb"));
    expect(rendered).toHaveLength(1);
    expect(rendered[0].getAttribute("data-error-id")).toBe("inner");
    expect(calls.at(-1)?.error).toBe(innerError);
  });
});

describe("boundary lifecycle isolation", () => {
  it("a new boundary never inherits a disposed boundary's retry or error", async () => {
    const calls: FallbackCall[] = [];
    const sharedFallback = makeSharedFallback(calls);

    // Each generation uses the SAME fallback fn and the SAME error message.
    const observed: string[] = [];
    for (let generation = 0; generation < 8; generation++) {
      const err = Object.assign(new Error("Load failed"), { errorId: `gen-${generation}` });
      const b = makeBoundary(sharedFallback, err);
      const container = mount(b.node);
      await flush();
      b.trigger();
      await flush();

      observed.push(container.querySelector(".shared-fb")?.getAttribute("data-error-id") ?? "none");

      const call = calls.at(-1);
      expect(call?.error).toBe(err); // never a previous generation's Error
      call?.retry();
      container.remove();
    }

    expect(observed).toEqual(["gen-0", "gen-1", "gen-2", "gen-3", "gen-4", "gen-5", "gen-6", "gen-7"]);
  });

  it("a stale retry from a disposed boundary does not affect a live one", async () => {
    const calls: FallbackCall[] = [];
    const sharedFallback = makeSharedFallback(calls);

    const oldErr = Object.assign(new Error("Load failed"), { errorId: "old" });
    const old = makeBoundary(sharedFallback, oldErr);
    const oldContainer = mount(old.node);
    await flush();
    old.trigger();
    await flush();
    const staleRetry = calls.at(-1)?.retry;
    oldContainer.remove();

    const liveErr = Object.assign(new Error("Load failed"), { errorId: "live" });
    const live = makeBoundary(sharedFallback, liveErr);
    const liveContainer = mount(live.node);
    await flush();
    live.trigger();
    await flush();
    expect(liveContainer.querySelector(".shared-fb")?.getAttribute("data-error-id")).toBe("live");

    // Invoking the dead boundary's retry must not clear the live boundary.
    expect(() => staleRetry?.()).not.toThrow();
    await flush();
    expect(liveContainer.querySelector(".shared-fb")?.getAttribute("data-error-id")).toBe("live");
  });
});

describe("resetKeys getter failures use the central pipeline", () => {
  it("reaches the runtime handler exactly once, with an identifying context", async () => {
    const calls: Array<{ error: unknown; context: { phase: string; name?: string } }> = [];
    setRuntimeErrorHandler((error, context) => calls.push({ error, context }));

    const [k, setK] = signal(0);
    const node = ErrorBoundary(
      {
        resetKeys: [
          () => {
            k();
            throw new Error("reset-key failure");
          },
        ],
      },
      () => div({ nodes: "content" }),
    );
    mount(node);
    await flush();

    expect(calls).toHaveLength(1);
    expect((calls[0].error as Error).message).toBe("reset-key failure");
    expect(calls[0].context.phase).toBe("effect");
    expect(calls[0].context.name).toBe("ErrorBoundary.resetKeys");
    setK(1);
  });

  it("reaches console.error — not console.warn — when no handler is installed", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const node = ErrorBoundary(
      {
        resetKeys: [
          () => {
            throw new Error("reset-key console path");
          },
        ],
      },
      () => div({ nodes: "content" }),
    );
    mount(node);
    await flush();

    const errMessages = errSpy.mock.calls.map((c) => String(c[0]));
    expect(errMessages.filter((m) => m.includes("reset-key console path"))).toHaveLength(1);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("reset-key console path");
  });

  it("stays observable with developer warnings disabled", async () => {
    const g = globalThis as Record<string, unknown>;
    const previous = g.__SIBU_DEV_WARN__;
    g.__SIBU_DEV_WARN__ = false;
    try {
      const seen: string[] = [];
      setRuntimeErrorHandler((error) => seen.push((error as Error).message));

      const node = ErrorBoundary(
        {
          resetKeys: [
            () => {
              throw new Error("reset-key in production");
            },
          ],
        },
        () => div({ nodes: "content" }),
      );
      mount(node);
      await flush();

      expect(seen).toEqual(["reset-key in production"]);
    } finally {
      if (previous === undefined) delete g.__SIBU_DEV_WARN__;
      else g.__SIBU_DEV_WARN__ = previous;
    }
  });

  it("does not stop the boundary from still resetting on a working key", async () => {
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal("a");
    const [fail, setFail] = signal(false);

    const node = ErrorBoundary(
      {
        fallback: () => div({ class: "rk-fb", nodes: "failed" }),
        resetKeys: [
          () => {
            throw new Error("bad key");
          },
          route,
        ],
      },
      () =>
        div({
          nodes: () => {
            if (fail()) throw new Error("child broke");
            return "ok";
          },
        }),
    );
    const container = mount(node);
    await flush();

    setFail(true);
    await flush();
    expect(container.querySelector(".rk-fb")).toBeTruthy();

    // A throwing key must not prevent the working key from resetting.
    setFail(false);
    setRoute("b");
    await flush();
    expect(container.querySelector(".rk-fb")).toBeNull();
  });

  it("a throwing reset key does not corrupt unrelated reactive work", async () => {
    setRuntimeErrorHandler(() => {});
    const [n, setN] = signal(0);

    const node = ErrorBoundary(
      {
        resetKeys: [
          () => {
            n();
            throw new Error("noisy key");
          },
        ],
      },
      () => div({ nodes: "content" }),
    );
    mount(node);
    await flush();

    let observed = 0;
    const [m, setM] = signal(0);
    const stop = effect(() => {
      observed = m();
    });
    setN(1);
    setM(42);
    expect(observed).toBe(42);
    stop();
  });
});

describe("documented limitation — a binding that throws before its node is attached", () => {
  it("reports through the handler because no boundary can be located yet", async () => {
    // Boundary lookup walks parentNode. A binding whose getter throws during
    // the INITIAL construction of its element has no parent yet, so there is no
    // boundary to offer it to and it resolves to the handler/console. A throw
    // that propagates out of `children()` normally (the usual component case)
    // is still caught by the boundary's own try/catch.
    const seen: string[] = [];
    setRuntimeErrorHandler((error) => seen.push((error as Error).message));

    const node = ErrorBoundary({ fallback: () => div({ class: "init-fb", nodes: "caught" }) }, () =>
      div({
        nodes: () => {
          throw new Error("throws on first render");
        },
      }),
    );
    const container = mount(node);
    await flush();

    expect(seen).toContain("throws on first render");
    expect(container.querySelector(".init-fb")).toBeNull();
  });

  it("a component that throws directly IS caught by the boundary", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);

    const node = ErrorBoundary({ fallback: () => div({ class: "direct-fb", nodes: "caught" }) }, () => {
      throw new Error("component threw directly");
    });
    const container = mount(node);
    await flush();

    expect(container.querySelector(".direct-fb")?.textContent).toBe("caught");
    expect(handler).not.toHaveBeenCalled();
  });
});
