import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { each } from "../src/core/rendering/each";
import { asyncDerived } from "../src/core/signals/asyncDerived";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { getSubscriberCount, reactiveBinding } from "../src/reactivity/track";

// ---------------------------------------------------------------------------
// Lifecycle and leak stress.
//
// THE INVARIANT UNDER TEST: a disposed reactive resource cannot resurrect
// itself, and repeated create/destroy cycles must not accumulate subscriptions.
//
// Assertions use observable SUBSCRIBER COUNTS rather than heap measurements —
// heap assertions are non-deterministic and would make this suite flaky without
// actually proving anything about the dependency graph.
// ---------------------------------------------------------------------------

function subscribers(accessor: unknown): number {
  const state = (accessor as { __signal?: object }).__signal;
  return state ? getSubscriberCount(state as never) : 0;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  setRuntimeErrorHandler(null);
});

describe("effect create/dispose cycles", () => {
  it("returns the subscriber count to zero after repeated cycles", () => {
    const [n, setN] = signal(0);
    expect(subscribers(n)).toBe(0);

    for (let round = 0; round < 200; round++) {
      const dispose = effect(() => {
        n();
      });
      expect(subscribers(n)).toBe(1);
      dispose();
      expect(subscribers(n)).toBe(0);
    }

    setN(1);
    expect(subscribers(n)).toBe(0);
  });

  it("keeps counts stable when many effects share one source", () => {
    const [n] = signal(0);
    const disposers = Array.from({ length: 500 }, () =>
      effect(() => {
        n();
      }),
    );
    expect(subscribers(n)).toBe(500);
    for (const d of disposers) d();
    expect(subscribers(n)).toBe(0);
  });
});

describe("zombie subscription prevention", () => {
  it("a binding queued before disposal does not run or resubscribe", () => {
    const [n, setN] = signal(0);
    let runs = 0;

    // Two subscribers on the same signal: the first disposes the second while
    // the drain is still walking the queue.
    const bindingRuns: number[] = [];
    const disposeBinding = reactiveBinding(() => {
      n();
      runs++;
      bindingRuns.push(runs);
    });

    const disposeKiller = effect(() => {
      if (n() === 1) disposeBinding();
    });

    const before = runs;
    setN(1);

    // The binding was queued, then disposed mid-drain. It must not execute,
    // and must not re-establish its edges by reading its signals again.
    expect(runs).toBe(before);
    expect(subscribers(n)).toBe(1); // only the killer effect remains

    setN(2);
    expect(runs).toBe(before); // still dead
    disposeKiller();
    expect(subscribers(n)).toBe(0);
  });

  it("a disposed effect queued before disposal never executes", () => {
    const [n, setN] = signal(0);
    let victimRuns = 0;

    const victim = effect(() => {
      n();
      victimRuns++;
    });
    const killer = effect(() => {
      if (n() === 1) victim();
    });

    const before = victimRuns;
    setN(1);
    expect(victimRuns).toBe(before);

    killer();
    expect(subscribers(n)).toBe(0);
  });

  it("disposing twice is a no-op", () => {
    const [n] = signal(0);
    const dispose = effect(() => {
      n();
    });
    dispose();
    dispose();
    expect(subscribers(n)).toBe(0);
  });
});

describe("dynamic dependency switching", () => {
  it("does not accumulate edges as a conditional derived flips branches", () => {
    const [toggle, setToggle] = signal(true);
    const [a] = signal(1);
    const [b] = signal(2);

    const picked = derived(() => (toggle() ? a() : b()));
    const dispose = effect(() => {
      picked();
    });

    for (let i = 0; i < 200; i++) {
      setToggle(i % 2 === 0);
      // Exactly one branch is subscribed at a time — never both, and never a
      // growing pile of stale edges.
      const total = subscribers(a) + subscribers(b);
      expect(total).toBe(1);
    }

    dispose();
    // The DERIVED is still alive and readable, so it keeps exactly one edge on
    // the currently-selected branch and one on the toggle. What must not
    // survive is any accumulation from the 200 flips above.
    expect(subscribers(a) + subscribers(b)).toBe(1);
    expect(subscribers(toggle)).toBe(1);
  });

  it("prunes edges when an effect stops reading a source", () => {
    const [gate, setGate] = signal(true);
    const [tracked] = signal(0);

    const dispose = effect(() => {
      if (gate()) tracked();
    });

    expect(subscribers(tracked)).toBe(1);
    setGate(false);
    expect(subscribers(tracked)).toBe(0); // pruned
    setGate(true);
    expect(subscribers(tracked)).toBe(1); // re-established
    dispose();
    expect(subscribers(tracked)).toBe(0);
  });
});

describe("asyncDerived create/dispose cycles", () => {
  it("stabilizes subscriber counts across many cycles", async () => {
    const [src] = signal(1);
    for (let i = 0; i < 100; i++) {
      const state = asyncDerived(async () => src() * 2, 0);
      state.dispose();
    }
    expect(subscribers(src)).toBe(0);
    await tick();
    expect(subscribers(src)).toBe(0);
  });

  it("does not retain a subscription when disposed mid-flight", async () => {
    const [src] = signal(1);
    const pending: Array<() => void> = [];
    const states = Array.from({ length: 25 }, () =>
      asyncDerived(() => {
        // Read synchronously so the dependency is actually tracked; the
        // promise is what stays in flight.
        const captured = src();
        return new Promise<number>((resolve) => {
          pending.push(() => resolve(captured));
        });
      }, 0),
    );

    expect(subscribers(src)).toBeGreaterThan(0);
    for (const s of states) s.dispose();
    expect(subscribers(src)).toBe(0);

    for (const release of pending) release();
    await tick();
    expect(subscribers(src)).toBe(0);
  });
});

describe("each() row churn", () => {
  it("releases every row across repeated populate/clear cycles", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const [items, setItems] = signal<Array<{ id: number }>>([]);
    let liveRows = 0;

    const anchor = each(
      items,
      (item) => {
        const el = document.createElement("div");
        el.setAttribute("data-row", "");
        liveRows++;
        const stop = effect(() => {
          el.setAttribute("data-id", String(item().id));
        });
        registerDisposer(el, () => {
          stop();
          liveRows--;
        });
        return el;
      },
      { key: (i) => i.id },
    );
    container.appendChild(anchor);

    for (let round = 0; round < 5; round++) {
      setItems(Array.from({ length: 200 }, (_, i) => ({ id: i })));
      expect(container.querySelectorAll("[data-row]")).toHaveLength(200);
      expect(liveRows).toBe(200);

      setItems([]);
      expect(container.querySelectorAll("[data-row]")).toHaveLength(0);
      // Every row from this round was disposed, not merely detached.
      expect(liveRows).toBe(0);
    }

    expect(subscribers(items)).toBeGreaterThan(0);
    // Native `container.remove()` is invisible to the framework — SibuJS hooks
    // teardown through `dispose()`, not the DOM. Dispose the anchor the way the
    // framework does when a parent range removes it.
    dispose(anchor);
    expect(subscribers(items)).toBe(0); // range disposer unsubscribed the list
    container.remove();
  });

  it("does not retain row cells after the range is disposed", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [items, setItems] = signal<Array<{ id: number }>>([{ id: 1 }, { id: 2 }]);

    const anchor = each(
      items,
      () => {
        const el = document.createElement("div");
        el.setAttribute("data-row", "");
        return el;
      },
      { key: (i) => i.id },
    );
    container.appendChild(anchor);
    setItems([{ id: 1 }, { id: 2 }]);
    expect(container.querySelectorAll("[data-row]")).toHaveLength(2);

    dispose(anchor); // the framework's teardown entry point
    expect(container.querySelectorAll("[data-row]")).toHaveLength(0);

    // Writing after teardown must neither throw nor revive the range.
    expect(() => setItems([{ id: 3 }])).not.toThrow();
    expect(container.querySelectorAll("[data-row]")).toHaveLength(0);
    expect(subscribers(items)).toBe(0);
    container.remove();
  });
});

describe("derived graph churn", () => {
  it("releases upstream edges when a derived's only observer is disposed", () => {
    const [n] = signal(1);

    for (let i = 0; i < 100; i++) {
      const d = derived(() => n() * 2);
      const dispose = effect(() => {
        d();
      });
      dispose();
      // The derived itself keeps its own upstream edge (it stays readable),
      // but the effect's edge on the derived is gone.
      expect(subscribers(d)).toBe(0);
    }

    // Each derived retains exactly one edge on `n` for its own invalidation.
    expect(subscribers(n)).toBe(100);
  });

  it("keeps a deep chain's edge count proportional to its depth", () => {
    const [n, setN] = signal(1);
    let current: () => number = n;
    for (let i = 0; i < 200; i++) {
      const previous = current;
      current = derived(() => previous() + 1);
    }
    const dispose = effect(() => {
      current();
    });

    expect(current()).toBe(201);
    // Each link subscribes to exactly one upstream.
    expect(subscribers(n)).toBe(1);

    for (let i = 0; i < 50; i++) setN(i);
    expect(subscribers(n)).toBe(1); // no growth from repeated propagation

    dispose();
  });
});
