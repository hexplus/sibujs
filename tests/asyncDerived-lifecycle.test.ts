import { describe, expect, it } from "vitest";
import { asyncDerived } from "../src/core/signals/asyncDerived";
import { signal } from "../src/core/signals/signal";
import { getSubscriberCount } from "../src/reactivity/track";

// ---------------------------------------------------------------------------
// asyncDerived lifetime contract.
//
// THE INVARIANT UNDER TEST: an async resource has a defined lifetime, and a
// disposed reactive resource cannot resurrect itself.
//
// Regression origin: `asyncDerived` created an internal effect and discarded
// its disposer, exposing no way to stop it — so it stayed subscribed to its
// sources for the lifetime of the page, re-running on every upstream change.
// ---------------------------------------------------------------------------

/** Subscriber count of the signal behind an accessor, for leak assertions. */
function subscribers(accessor: unknown): number {
  const state = (accessor as { __signal?: object }).__signal;
  return state ? getSubscriberCount(state as never) : 0;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("asyncDerived — ownership and disposal", () => {
  it("exposes dispose() and unsubscribes from its sources", async () => {
    const [src, setSrc] = signal(1);
    const state = asyncDerived(async () => src() * 2, 0);

    expect(subscribers(src)).toBeGreaterThan(0);
    await tick();
    expect(state.value()).toBe(2);

    state.dispose();
    expect(subscribers(src)).toBe(0);

    // A source change after disposal must not start another run.
    setSrc(21);
    await tick();
    expect(state.value()).toBe(2);
  });

  it("is idempotent", () => {
    const [src] = signal(1);
    const state = asyncDerived(async () => src(), 0);
    expect(() => {
      state.dispose();
      state.dispose();
      state.dispose();
    }).not.toThrow();
    expect(subscribers(src)).toBe(0);
  });

  it("ignores a promise that resolves after disposal", async () => {
    const [src] = signal(1);
    let release: (value: number) => void = () => {};
    const state = asyncDerived(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
      -1,
    );

    expect(state.loading()).toBe(true);
    state.dispose();

    release(999); // settles after teardown
    await tick();

    expect(state.value()).toBe(-1); // state frozen at disposal
    expect(subscribers(src)).toBe(0);
  });

  it("ignores a rejection that arrives after disposal", async () => {
    let reject: (reason: unknown) => void = () => {};
    const state = asyncDerived(
      () =>
        new Promise<number>((_resolve, rej) => {
          reject = rej;
        }),
      0,
    );

    state.dispose();
    reject(new Error("too late"));
    await tick();

    expect(state.error()).toBeNull();
  });

  it("makes refresh() a no-op after disposal", async () => {
    let runs = 0;
    const state = asyncDerived(async () => {
      runs++;
      return runs;
    }, 0);
    await tick();
    const afterFirst = runs;

    state.dispose();
    state.refresh();
    await tick();

    expect(runs).toBe(afterFirst);
  });

  it("does not accumulate subscriptions across create/dispose cycles", async () => {
    const [src] = signal(1);
    for (let i = 0; i < 50; i++) {
      const state = asyncDerived(async () => src(), 0);
      state.dispose();
    }
    expect(subscribers(src)).toBe(0);
  });
});

describe("asyncDerived — cancellation", () => {
  it("passes an AbortSignal to the factory", async () => {
    let received: AbortSignal | undefined;
    const state = asyncDerived(async ({ signal: abortSignal }) => {
      received = abortSignal;
      return 1;
    }, 0);

    await tick();
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(false);
    state.dispose();
  });

  it("aborts the in-flight run when a newer run supersedes it", async () => {
    const [q, setQ] = signal("a");
    const signals: AbortSignal[] = [];

    const state = asyncDerived(async ({ signal: abortSignal }) => {
      signals.push(abortSignal);
      const value = q();
      await tick();
      return value;
    }, "");

    setQ("b"); // supersede run 1

    await tick();
    await tick();

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true); // superseded
    expect(signals[1].aborted).toBe(false); // current
    expect(state.value()).toBe("b");
    state.dispose();
  });

  it("aborts the in-flight run on dispose", async () => {
    let captured: AbortSignal | undefined;
    const state = asyncDerived(async ({ signal: abortSignal }) => {
      captured = abortSignal;
      await new Promise(() => {}); // never settles
      return 0;
    }, 0);

    await tick();
    expect(captured?.aborted).toBe(false);
    state.dispose();
    expect(captured?.aborted).toBe(true);
  });

  it("still drops a stale result when the factory ignores the AbortSignal", async () => {
    // Aborting alone does not close the stale-completion race: not every async
    // API honours AbortSignal, so the run-id guard must stand on its own.
    const [q, setQ] = signal("first");
    const resolvers: Array<(v: string) => void> = [];

    const state = asyncDerived(() => {
      const value = q();
      return new Promise<string>((resolve) => {
        resolvers.push(() => resolve(value));
      });
    }, "");

    setQ("second");
    await tick();

    expect(resolvers).toHaveLength(2);
    resolvers[1]("second"); // newer settles first
    await tick();
    expect(state.value()).toBe("second");

    resolvers[0]("first"); // stale settles late and must be ignored
    await tick();
    expect(state.value()).toBe("second");

    state.dispose();
  });
});

describe("asyncDerived — dependency tracking across await", () => {
  it("tracks reads that happen before the first await", async () => {
    const [a, setA] = signal(1);
    let runs = 0;
    const state = asyncDerived(async () => {
      runs++;
      const value = a(); // synchronous read — tracked
      await tick();
      return value;
    }, 0);

    await tick();
    await tick();
    expect(state.value()).toBe(1);

    setA(2);
    await tick();
    await tick();
    expect(runs).toBe(2);
    expect(state.value()).toBe(2);
    state.dispose();
  });

  it("does NOT track reads that happen after an await (documented limitation)", async () => {
    const [before, setBefore] = signal(1);
    const [after, setAfter] = signal(100);
    let runs = 0;

    const state = asyncDerived(async () => {
      runs++;
      before(); // tracked
      await tick();
      return after(); // NOT tracked — the tracking context is gone
    }, 0);

    await tick();
    await tick();
    const runsAfterFirst = runs;

    // Changing a post-await dependency must not re-run the factory. This is a
    // property of synchronous tracking, documented on `asyncDerived`.
    setAfter(200);
    await tick();
    await tick();
    expect(runs).toBe(runsAfterFirst);

    // The pre-await dependency still drives re-runs.
    setBefore(2);
    await tick();
    await tick();
    expect(runs).toBe(runsAfterFirst + 1);
    expect(state.value()).toBe(200); // picked up on the next run

    state.dispose();
  });
});

describe("asyncDerived — backward compatibility", () => {
  it("accepts a zero-argument factory", async () => {
    const [n] = signal(21);
    // The pre-existing `() => Promise<T>` form must keep working unchanged.
    const state = asyncDerived(async () => n() * 2, 0);
    await tick();
    expect(state.value()).toBe(42);
    state.dispose();
  });

  it("still exposes value/loading/error/refresh", async () => {
    let runs = 0;
    const state = asyncDerived(async () => ++runs, 0);
    expect(typeof state.value).toBe("function");
    expect(typeof state.loading).toBe("function");
    expect(typeof state.error).toBe("function");
    expect(typeof state.refresh).toBe("function");

    await tick();
    expect(state.loading()).toBe(false);
    expect(state.error()).toBeNull();

    state.refresh();
    await tick();
    expect(state.value()).toBe(2);
    state.dispose();
  });

  it("reports a synchronous factory throw as an error", async () => {
    const state = asyncDerived<number>(() => {
      throw new Error("sync factory boom");
    }, 0);
    await tick();
    expect((state.error() as Error).message).toBe("sync factory boom");
    expect(state.loading()).toBe(false);
    state.dispose();
  });
});
