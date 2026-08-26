// ---------------------------------------------------------------------------
// Teardown reentrancy (ENH-004).
//
// `ctx.cleanup()` stays reachable from inside a teardown, so disposal and
// rollback both drain a queue that can grow while it is being drained. The
// invariant under test:
//
//     BOUNDED REENTRANCY PROTECTION  ≠  SILENTLY ABANDON REGISTERED CLEANUP
//
// A finite chain of any practical depth must drain completely. A pathological
// infinite producer must be stopped and *reported* — never silently dropped,
// and never allowed to hang or overflow the stack.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { signal } from "../src/core/signals/signal";
import { type EnhanceContext, enhance } from "../src/platform/enhance";

function serverRender(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html.trim();
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

const COUNTER_HTML = `<div><b data-ref="n">0</b><button data-ref="b">x</button></div>`;

/** Register a cleanup that registers the next link, down to `depth`. */
function chain(ctx: EnhanceContext, calls: number[], depth: number, at = 1): void {
  ctx.cleanup(() => {
    calls.push(at);
    if (at < depth) chain(ctx, calls, depth, at + 1);
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ENH-004 — reentrant cleanup chains drain completely", () => {
  it("drains a 1-level reentrant chain (the previously covered case)", () => {
    const root = serverRender(COUNTER_HTML);
    const calls: number[] = [];

    expect(() =>
      enhance(root, (ctx) => {
        chain(ctx, calls, 2);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(calls).toEqual([1, 2]);
  });

  it("drains a 12-level reentrant chain on ROLLBACK", () => {
    const root = serverRender(COUNTER_HTML);
    const calls: number[] = [];

    expect(() =>
      enhance(root, (ctx) => {
        chain(ctx, calls, 12);
        throw new Error("setup failed");
      }),
    ).toThrow("setup failed");

    // Nothing may be lost merely for crossing an internal pass boundary.
    expect(calls).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);
  });

  it("drains a 12-level reentrant chain on NORMAL DISPOSE", () => {
    const root = serverRender(COUNTER_HTML);
    const calls: number[] = [];
    const [n, setN] = signal(0);

    const stop = enhance(root, (ctx) => {
      ctx.text("@n", () => n());
      chain(ctx, calls, 12);
    });

    // Vacuity guard: the enhancement really committed and really bound.
    setN(1);
    expect(root.querySelector('[data-ref="n"]')?.textContent).toBe("1");
    expect(calls).toEqual([]); // nothing has torn down yet

    stop();
    expect(calls).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);
  });

  it("drains a deep (200-level) finite chain without recursion limits", () => {
    const root = serverRender(COUNTER_HTML);
    const calls: number[] = [];

    const stop = enhance(root, (ctx) => chain(ctx, calls, 200));
    stop();

    expect(calls.length).toBe(200);
    expect(calls[0]).toBe(1);
    expect(calls[199]).toBe(200);
  });

  it("keeps dispose idempotent when the chain has already drained", () => {
    const root = serverRender(COUNTER_HTML);
    const calls: number[] = [];

    const stop = enhance(root, (ctx) => chain(ctx, calls, 12));
    stop();
    stop();
    stop();

    expect(calls.length).toBe(12); // at most once per registered teardown
  });

  it("runs each queued teardown at most once across a reentrant chain", () => {
    const root = serverRender(COUNTER_HTML);
    const runs = new Map<string, number>();
    const bump = (id: string) => runs.set(id, (runs.get(id) ?? 0) + 1);

    const stop = enhance(root, (ctx) => {
      ctx.cleanup(() => {
        bump("A");
        ctx.cleanup(() => {
          bump("B");
          ctx.cleanup(() => bump("D"));
        });
      });
      ctx.cleanup(() => {
        bump("C");
        ctx.cleanup(() => bump("E"));
      });
    });

    stop();
    expect(Object.fromEntries(runs)).toEqual({ A: 1, B: 1, C: 1, D: 1, E: 1 });
  });

  it("keeps draining a chain when a link throws, and preserves the setup error", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = serverRender(COUNTER_HTML);
    const calls: number[] = [];
    const original = new TypeError("original setup failure");

    let thrown: unknown;
    try {
      enhance(root, (ctx) => {
        // A registers B; B throws but still registers C; C registers D…
        const link = (at: number): void => {
          ctx.cleanup(() => {
            calls.push(at);
            if (at < 12) link(at + 1);
            if (at === 5) throw new Error("link 5 exploded");
          });
        };
        link(1);
        throw original;
      });
    } catch (e) {
      thrown = e;
    }

    expect(calls).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); // chain survived the throw
    expect(thrown).toBe(original); // original error still authoritative, by identity
    expect(err).toHaveBeenCalled(); // teardown failure reported separately
  });
});

describe("ENH-004 — runaway cleanup protection", () => {
  it("stops an infinite self-registering cleanup instead of hanging", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = serverRender(COUNTER_HTML);
    let runs = 0;

    const stop = enhance(root, (ctx) => {
      const again = (): void => {
        runs++;
        ctx.cleanup(again);
      };
      ctx.cleanup(again);
    });

    const started = Date.now();
    expect(() => stop()).not.toThrow(); // no hang, no stack overflow
    expect(Date.now() - started).toBeLessThan(10_000);

    // It really ran a lot of work before giving up (vacuity guard)…
    expect(runs).toBeGreaterThan(1_000);
    // …and the runaway was reported rather than silently swallowed.
    expect(err).toHaveBeenCalledWith(expect.stringContaining("runaway"), expect.anything());
  });

  it("reports the runaway on the rollback path too, without masking the setup error", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = serverRender(COUNTER_HTML);
    const original = new Error("setup X");

    let thrown: unknown;
    try {
      enhance(root, (ctx) => {
        const again = (): void => ctx.cleanup(again);
        ctx.cleanup(again);
        throw original;
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBe(original); // runaway never replaces the setup error
    expect(err).toHaveBeenCalledWith(expect.stringContaining("runaway"), expect.anything());
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Core dispose() — the analogous boundary, audited narrowly.
// ---------------------------------------------------------------------------

describe("ENH-004 — core dispose() reentrancy boundary", () => {
  it("drains a 12-level reentrant disposer chain on a node", () => {
    const node = document.createElement("div");
    document.body.appendChild(node);
    const calls: number[] = [];

    const link = (at: number): void => {
      registerDisposer(node, () => {
        calls.push(at);
        if (at < 12) link(at + 1);
      });
    };
    link(1);

    dispose(node);
    expect(calls).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("stops an infinite self-registering disposer and reports it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const node = document.createElement("div");
    document.body.appendChild(node);
    let runs = 0;

    const again = (): void => {
      runs++;
      registerDisposer(node, again);
    };
    registerDisposer(node, again);

    const started = Date.now();
    expect(() => dispose(node)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(runs).toBeGreaterThan(1_000);

    const reported =
      warn.mock.calls.some((c) => String(c[0]).includes("runaway")) ||
      err.mock.calls.some((c) => String(c[0]).includes("runaway"));
    expect(reported).toBe(true);
  });
});
