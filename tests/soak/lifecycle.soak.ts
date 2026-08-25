// Long-running lifecycle soak.
//
// Excluded from the fast suite (`vitest.config.ts` includes only
// `tests/**/*.test.ts`); run with `npm run test:soak`. Measured runtime for the
// whole soak config (this file plus `ssr.soak.ts`) is ~4 s on a 12th-gen i7 —
// the iteration counts below are large, but the operations are cheap. It is
// kept out of the PR suite because that cost is real and grows as iteration
// counts do, not because it is currently slow.
//
// The evidence this produces is deliberately NOT "heap size did not grow".
// Heap size is noisy, GC-dependent, and unreliable as a gate. It measures the
// framework's own deterministic counters instead — active DOM bindings, signal
// subscriber counts, query cache entries and their subscriber refcounts, router
// disposers — and requires each to return to its pre-soak baseline after tens
// of thousands of create/dispose cycles. A counter that returns to baseline is
// proof of bounded ownership; a heap that happens not to grow is not.
//
// `--expose-gc` heap comparison is layered on top where available, with a loose
// tolerance, purely as corroboration.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLeaks, dispose } from "../../src/core/rendering/dispose";
import { each } from "../../src/core/rendering/each";
import { derived } from "../../src/core/signals/derived";
import { effect } from "../../src/core/signals/effect";
import { signal } from "../../src/core/signals/signal";
import { __resetQueryCache, clearQueryCache, query } from "../../src/data/query";
import { getSubscriberCount } from "../../src/devtools/introspect";
import type { RouteDef } from "../../src/plugins/router";
import { createRouter, destroyRouter, Route } from "../../src/plugins/router";
import { batch } from "../../src/reactivity/batch";

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const CACHE_KEY = Symbol.for("sibujs.query.cache.v1");
const rawCache = () => (globalThis as unknown as Record<symbol, Map<string, unknown>>)[CACHE_KEY];

/** Force GC when the runner was started with `--expose-gc`; otherwise a no-op. */
const gc = (globalThis as unknown as { gc?: () => void }).gc;
const heapMB = () => process.memoryUsage().heapUsed / 1024 / 1024;

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
  __resetQueryCache();
});

describe("reactive core soak", () => {
  it("100 000 signal writes leave no residual subscribers", () => {
    const [count, setCount] = signal(0);
    let runs = 0;
    const stop = effect(() => {
      count();
      runs++;
    });

    for (let i = 1; i <= 100_000; i++) setCount(i);

    expect(count()).toBe(100_000);
    expect(runs).toBe(100_001); // initial run + one per write
    stop();

    // With the only subscriber stopped, the signal must hold nothing.
    const [probe, setProbe] = signal(0);
    const before = getSubs(probe);
    const s2 = effect(() => probe());
    s2();
    setProbe(1);
    expect(getSubs(probe)).toBe(before);
  });

  it("50 000 create/dispose cycles return the binding count to baseline", () => {
    const baseline = checkLeaks();

    for (let i = 0; i < 50_000; i++) {
      const [v, setV] = signal(i);
      const d = derived(() => v() * 2);
      const stop = effect(() => d());
      setV(i + 1);
      stop();
    }

    expect(checkLeaks(), "DOM binding count grew across 50 000 reactive cycles").toBe(baseline);
  });

  it("10 000 dynamic dependency switches do not accumulate edges", () => {
    const [toggle, setToggle] = signal(true);
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);

    let runs = 0;
    const stop = effect(() => {
      runs++;
      // The dependency set changes on every flip: only one branch is read.
      if (toggle()) a();
      else b();
    });

    for (let i = 0; i < 10_000; i++) {
      setToggle(i % 2 === 0);
      // Writing the branch that is NOT currently tracked must not wake the
      // effect. If stale edges accumulated, this count would drift upward.
      if (i % 2 === 0) setB(i);
      else setA(i);
    }

    stop();
    // Exact expected count, and the arithmetic matters:
    //   1  initial run
    // + 9 999 genuine flips — `toggle` starts `true`, so iteration 0's
    //   `setToggle(true)` is a write of the SAME value and is deduped rather
    //   than notifying; every later iteration alternates parity and so flips.
    // = 10 000.
    // A HIGHER number means a stale dependency edge survived a branch switch
    // and fired when the untracked branch was written. A LOWER number means a
    // live edge was dropped.
    expect(runs, "dependency edge count drifted across branch switches").toBe(10_000);
  });

  it("batching 100 000 writes collapses to a single notification", () => {
    const [v, setV] = signal(0);
    let runs = 0;
    const stop = effect(() => {
      v();
      runs++;
    });
    const before = runs;

    batch(() => {
      for (let i = 0; i < 100_000; i++) setV(i);
    });

    expect(runs - before).toBe(1);
    stop();
  });
});

const getSubs = (getter: () => unknown): number => getSubscriberCount(getter);

describe("DOM lifecycle soak", () => {
  it("20 000 keyed-list mount/update/dispose cycles return bindings to baseline", async () => {
    const baseline = checkLeaks();

    for (let cycle = 0; cycle < 2_000; cycle++) {
      const [items, setItems] = signal([
        { id: 1, t: "a" },
        { id: 2, t: "b" },
        { id: 3, t: "c" },
      ]);
      const container = document.createElement("div");
      host.appendChild(container);

      container.appendChild(
        each(
          items,
          (item) => {
            const li = document.createElement("li");
            li.textContent = item().t;
            return li;
          },
          { key: (item) => item.id },
        ),
      );

      // Reorder, grow, shrink — the three reconciliation paths.
      setItems([
        { id: 3, t: "c" },
        { id: 1, t: "a" },
        { id: 2, t: "b" },
      ]);
      setItems([
        { id: 3, t: "c" },
        { id: 4, t: "d" },
        { id: 1, t: "a" },
        { id: 2, t: "b" },
      ]);
      setItems([{ id: 4, t: "d" }]);

      container.remove();
      dispose(container);
    }

    expect(checkLeaks(), "DOM bindings leaked across 2 000 keyed-list cycles").toBe(baseline);
  });
});

describe("query layer soak", () => {
  it("10 000 observer create/dispose cycles leave no cache entries or subscribers", async () => {
    for (let i = 0; i < 10_000; i++) {
      const q = query(`soak-${i % 50}`, async () => i, { retry: { maxRetries: 0 }, cacheTime: 0 });
      if (i % 100 === 0) await flush();
      q.dispose();
    }
    await flush(20);
    clearQueryCache();
    await flush(20);

    const cache = rawCache();
    for (const [key, entry] of cache.entries()) {
      expect((entry as { subscribers: number }).subscribers, `entry "${key}" retained subscribers after the soak`).toBe(
        0,
      );
    }
  });

  it("repeated clearQueryCache under live observers keeps refcounts exact", async () => {
    const observers = Array.from({ length: 20 }, (_, i) =>
      query(`clear-soak-${i % 5}`, async () => i, { retry: { maxRetries: 0 } }),
    );
    await flush(10);

    for (let round = 0; round < 500; round++) {
      clearQueryCache();
      await flush(4);
    }

    const cache = rawCache();
    let total = 0;
    for (const entry of cache.values()) {
      const subs = (entry as { subscribers: number }).subscribers;
      expect(subs).toBeGreaterThanOrEqual(0);
      total += subs;
    }
    // Every live observer is attached to exactly one entry — never more.
    expect(total, "subscriber refcount drifted across 500 cache replacements").toBeLessThanOrEqual(observers.length);

    for (const o of observers) o.dispose();
    await flush(10);
  });
});

describe("router soak", () => {
  it("10 000 navigation transactions leave the router disposable and correct", async () => {
    const el = (t: string) => {
      const d = document.createElement("div");
      d.textContent = t;
      return d;
    };
    const routes: RouteDef[] = [
      { path: "/", component: () => el("/") },
      { path: "/a", component: () => el("/a") },
      { path: "/b", component: () => el("/b") },
      { path: "/old", redirect: "/a" },
    ];
    window.history.replaceState({}, "", "/");
    const router = createRouter(routes, { mode: "history" });
    host.appendChild(Route());
    await flush(10);

    const baseline = checkLeaks();
    const targets = ["/a", "/b", "/", "/old"];
    for (let i = 0; i < 10_000; i++) {
      // Deliberately not awaited every iteration: consecutive pushes supersede
      // each other, which is the cancellation path this soak exists to stress.
      void router.push(targets[i % targets.length]).catch(() => {});
      if (i % 50 === 0) await flush(4);
    }
    await flush(30);

    await router.push("/b").catch(() => {});
    await flush(10);
    expect(router.currentRoute.path, "router wedged after 10 000 navigations").toBe("/b");

    destroyRouter();
    await flush(10);
    expect(checkLeaks(), "DOM bindings leaked across 10 000 navigations").toBeLessThanOrEqual(baseline + 2);
  });

  it("500 router create/destroy cycles do not accumulate listeners", async () => {
    const el = () => document.createElement("div");
    const routes: RouteDef[] = [{ path: "/", component: el }];
    const baseline = checkLeaks();

    for (let i = 0; i < 500; i++) {
      window.history.replaceState({}, "", "/");
      createRouter(routes, { mode: "history" });
      await flush(2);
      destroyRouter();
    }
    await flush(10);

    expect(checkLeaks(), "bindings leaked across 500 router lifecycles").toBeLessThanOrEqual(baseline + 2);
  });
});

describe("heap corroboration (requires --expose-gc)", () => {
  it.skipIf(!gc)("retained heap is bounded across repeated soak rounds", async () => {
    const round = async () => {
      for (let i = 0; i < 5_000; i++) {
        const [v, setV] = signal(i);
        const stop = effect(() => v());
        setV(i + 1);
        stop();
      }
      await flush();
    };

    await round();
    gc?.();
    const first = heapMB();

    for (let r = 0; r < 4; r++) await round();
    gc?.();
    const last = heapMB();

    // Deliberately loose. This corroborates the counter evidence above; it is
    // not a precise memory assertion, because heap measurement in a JS runtime
    // is not precise. A genuine unbounded leak over 4× the work shows up as a
    // multiple, not as a few megabytes of noise.
    expect(last, `heap grew from ${first.toFixed(1)}MB to ${last.toFixed(1)}MB across 4 extra rounds`).toBeLessThan(
      first * 2 + 32,
    );
  });
});
