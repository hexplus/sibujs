import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { external, signal } from "../src/core/signals/signal";
import { enhance } from "../src/platform/enhance";
import { batch } from "../src/reactivity/batch";
import { untracked } from "../src/reactivity/track";

// ---------------------------------------------------------------------------
// external() — the invalidation primitive for state SibuJS does not own.
//
// The contract under test: tracking and invalidation are SEPARATE, the source
// carries no value, it behaves like any other reactive source inside batches,
// computeds and effects, and it never revives a consumer that has been
// disposed.
// ---------------------------------------------------------------------------

/** A deliberately opaque mutable object — the stand-in for chess.js et al. */
class Engine {
  private state = { moves: 0, turn: "w" as "w" | "b" };
  move(): void {
    this.state.moves++;
    this.state.turn = this.state.turn === "w" ? "b" : "w";
  }
  get moves(): number {
    return this.state.moves;
  }
  get turn(): "w" | "b" {
    return this.state.turn;
  }
}

afterEach(() => {
  setRuntimeErrorHandler(null);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("external() — tracking is separate from invalidation", () => {
  it("re-runs consumers that tracked it, and only when invalidated", () => {
    const engine = new Engine();
    const moved = external();
    const seen: number[] = [];

    effect(() => {
      moved.track();
      seen.push(engine.moves);
    });

    expect(seen).toEqual([0]);

    // Mutating the engine alone changes nothing — SibuJS cannot see it.
    engine.move();
    expect(seen).toEqual([0]);

    // The explicit call is what publishes the change.
    moved.invalidate();
    expect(seen).toEqual([0, 1]);
  });

  it("does not re-run a consumer that never tracked it", () => {
    const moved = external();
    let runs = 0;

    effect(() => {
      runs++;
    });
    expect(runs).toBe(1);

    moved.invalidate();
    expect(runs).toBe(1);
  });

  it("invalidates every consumer of the same source", () => {
    const moved = external();
    const runs = [0, 0, 0];

    for (let i = 0; i < runs.length; i++) {
      effect(() => {
        moved.track();
        runs[i]++;
      });
    }

    moved.invalidate();
    expect(runs).toEqual([2, 2, 2]);
  });

  it("keeps independent sources independent (one source = one invalidation domain)", () => {
    const board = external();
    const clock = external();
    let boardRuns = 0;
    let clockRuns = 0;

    effect(() => {
      board.track();
      boardRuns++;
    });
    effect(() => {
      clock.track();
      clockRuns++;
    });

    board.invalidate();
    expect([boardRuns, clockRuns]).toEqual([2, 1]);

    clock.invalidate();
    expect([boardRuns, clockRuns]).toEqual([2, 2]);
  });

  it("exposes no value — track() returns nothing", () => {
    const moved = external();
    expect(moved.track()).toBeUndefined();
    expect(moved.invalidate()).toBeUndefined();
  });

  it("is a no-op outside a tracking context, like reading a signal", () => {
    const moved = external();
    expect(() => moved.track()).not.toThrow();

    let runs = 0;
    effect(() => {
      untracked(() => moved.track());
      runs++;
    });
    moved.invalidate();
    expect(runs).toBe(1); // the untracked read created no dependency
  });
});

describe("external() — batching", () => {
  it("notifies once per batch no matter how many invalidations happen", () => {
    const engine = new Engine();
    const moved = external();
    let runs = 0;

    effect(() => {
      moved.track();
      void engine.moves;
      runs++;
    });
    expect(runs).toBe(1);

    batch(() => {
      engine.move();
      moved.invalidate();
      engine.move();
      moved.invalidate();
      engine.move();
      moved.invalidate();
    });

    expect(runs).toBe(2); // one re-run, not three
    expect(engine.moves).toBe(3);
  });

  it("coalesces with ordinary signal writes in the same batch", () => {
    const moved = external();
    const [n, setN] = signal(0);
    let runs = 0;

    effect(() => {
      moved.track();
      n();
      runs++;
    });

    batch(() => {
      setN(1);
      moved.invalidate();
    });

    expect(runs).toBe(2);
  });

  it("external mutation during a batch is observed after the batch, once", () => {
    const engine = new Engine();
    const moved = external();
    const observed: number[] = [];

    effect(() => {
      moved.track();
      observed.push(engine.moves);
    });

    batch(() => {
      engine.move();
      engine.move();
      moved.invalidate();
      // Consumers have NOT run yet: the read below still sees the pre-batch view.
      expect(observed).toEqual([0]);
    });

    expect(observed).toEqual([0, 2]);
  });
});

describe("external() — computeds", () => {
  it("works inside derived() and propagates to its dependents", () => {
    const engine = new Engine();
    const moved = external();

    const label = derived(() => {
      moved.track();
      return `${engine.turn} to move`;
    });

    const seen: string[] = [];
    effect(() => {
      seen.push(label());
    });

    expect(seen).toEqual(["w to move"]);

    engine.move();
    moved.invalidate();
    expect(seen).toEqual(["w to move", "b to move"]);
  });

  it("a derived whose value did not change still stops propagation", () => {
    const engine = new Engine();
    const moved = external();
    // Deliberately reads something that does NOT change on every move.
    const parity = derived(() => {
      moved.track();
      return engine.moves % 2 === 0 ? "even" : "odd";
    });

    let runs = 0;
    effect(() => {
      parity();
      runs++;
    });
    expect(runs).toBe(1);

    engine.move(); // moves = 1 → "odd"
    moved.invalidate();
    expect(runs).toBe(2);

    // Two more moves: parity returns to "odd" → the computed's value is
    // unchanged, so the dependent effect must not re-run.
    engine.move();
    engine.move();
    moved.invalidate();
    expect(runs).toBe(2);
  });
});

describe("external() — ownership and disposal", () => {
  it("never invalidates a disposed effect", () => {
    const moved = external();
    let runs = 0;

    const stop = effect(() => {
      moved.track();
      runs++;
    });

    moved.invalidate();
    expect(runs).toBe(2);

    stop();
    moved.invalidate();
    moved.invalidate();
    expect(runs).toBe(2);
  });

  it("never invalidates bindings of a disposed enhancement", () => {
    const engine = new Engine();
    const moved = external();
    document.body.innerHTML = `<div id="w"><b data-ref="n">0</b></div>`;
    const root = document.getElementById("w") as HTMLElement;
    const node = root.querySelector('[data-ref="n"]') as HTMLElement;

    const stop = enhance(root, (ctx) => {
      ctx.text("@n", () => {
        moved.track();
        return engine.moves;
      });
    });

    engine.move();
    moved.invalidate();
    expect(node.textContent).toBe("1");

    stop();
    engine.move();
    moved.invalidate();
    expect(node.textContent).toBe("1"); // binding is gone, not stale-updated
  });

  it("a source outliving its consumers is inert, not an error", () => {
    const moved = external();
    const stop = effect(() => {
      moved.track();
    });
    stop();
    expect(() => {
      moved.invalidate();
      moved.invalidate();
    }).not.toThrow();
  });
});

describe("external() — error routing", () => {
  it("a throwing consumer is reported through the runtime pipeline with its own phase", () => {
    const reports: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
    setRuntimeErrorHandler((error, context) => reports.push({ error, context }));

    const moved = external();
    let armed = false;
    effect(() => {
      moved.track();
      if (armed) throw new Error("consumer boom");
    });

    armed = true;
    moved.invalidate();

    expect(reports).toHaveLength(1);
    expect((reports[0].error as Error).message).toBe("consumer boom");
    expect(reports[0].context.phase).toBe("effect");
  });

  it("a throwing consumer does not stop the others from being invalidated", () => {
    setRuntimeErrorHandler(() => {});
    const moved = external();
    let armed = false;
    let survivorRuns = 0;

    effect(() => {
      moved.track();
      if (armed) throw new Error("boom");
    });
    effect(() => {
      moved.track();
      survivorRuns++;
    });

    armed = true;
    moved.invalidate();
    expect(survivorRuns).toBe(2);
  });

  it("an enhancement binding that throws keeps its binding phase and node", () => {
    const reports: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
    setRuntimeErrorHandler((error, context) => reports.push({ error, context }));

    document.body.innerHTML = `<div id="w"><b data-ref="n">0</b></div>`;
    const root = document.getElementById("w") as HTMLElement;
    const node = root.querySelector('[data-ref="n"]') as HTMLElement;
    const moved = external();
    let armed = false;

    enhance(root, (ctx) => {
      ctx.text("@n", () => {
        moved.track();
        if (armed) throw new Error("binding boom");
        return "0";
      });
    });

    armed = true;
    moved.invalidate();

    expect(reports).toHaveLength(1);
    expect(reports[0].context.phase).toBe("binding");
    expect(reports[0].context.node).toBe(node);
  });
});

describe("external() — devtools labelling", () => {
  let hook: { emit: ReturnType<typeof vi.fn> } | undefined;

  beforeEach(() => {
    hook = { emit: vi.fn() };
    (globalThis as Record<string, unknown>).__SIBU_DEVTOOLS_GLOBAL_HOOK__ = hook;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).__SIBU_DEVTOOLS_GLOBAL_HOOK__ = undefined;
  });

  it("passes an optional name through to the devtools hook", () => {
    external({ name: "chess-engine" });
    const created = hook?.emit.mock.calls.filter((c) => c[0] === "signal:create") ?? [];
    expect(created.some((c) => (c[1] as { name?: string }).name === "chess-engine")).toBe(true);
  });
});
