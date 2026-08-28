/**
 * `optimisticList()` under REACTIVE REENTRANCY and hostile user code.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Setting `pending` notifies subscribers synchronously, and a subscriber may
 * call straight back into the list. An earlier version published in the middle
 * of its own mutation, so the operation that woke the subscriber was only half
 * applied — and then finished applying a plan computed before the subscriber
 * existed:
 *
 *     remove computes `kept` · publishes pending · effect wakes and add()s a row
 *       · remove resumes and assigns `visible = kept`     → the new row erased
 *
 *     older update claims a row · publishes pending · effect wakes and updates
 *       the same row · older update resumes and assigns its own owner
 *         → the older operation steals ownership back from the newer one
 *
 * Preparation is also where user code can throw. `{ ...row.value, ...patch }`
 * runs the patch's property getters, and doing that after the inflight slot was
 * taken leaked `pending()` as true forever.
 *
 * The operations now run PREPARE (all user code, mutates nothing) → COMMIT (no
 * user code, structural changes recomputed from the live list) → PUBLISH (one
 * batch). By the time a subscriber runs, the outer operation has nothing left to
 * apply.
 */

import { describe, expect, it } from "vitest";
import { effect } from "../src/core/signals/effect";
import { optimisticList } from "../src/patterns/optimistic";
import { createDeferred, type Deferred } from "./helpers/mocks";

function gate<T = void>(): Deferred<T> {
  const d = createDeferred<T>();
  d.promise.catch(() => {});
  return d;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

interface Item {
  id: number;
  value: string;
}

/**
 * Run `body` once, the first time the chosen signal(s) NOTIFY.
 *
 * The setup run is skipped deliberately. An effect executes once when it is
 * created, and firing there would start the "reentrant" operation before the
 * outer one — the opposite of the ordering under test.
 */
function onFirstNotification(
  list: { pending: () => boolean; items: () => unknown },
  watch: "pending" | "items" | "both",
  body: () => void,
): () => void {
  let runs = 0;
  let fired = false;
  return effect(() => {
    if (watch === "pending" || watch === "both") list.pending();
    if (watch === "items" || watch === "both") list.items();
    runs++;
    if (runs === 1 || fired) return;
    fired = true;
    body();
  });
}

// ─── Failure A: the outer operation must hold no stale structural plan ──────

describe("an outer operation cannot erase work a subscriber started", () => {
  for (const watch of ["pending", "items", "both"] as const) {
    it(`remove() keeps a row added by an effect watching ${watch}`, async () => {
      const list = optimisticList([1, 2, 3]);
      const removingGate = gate<void>();
      let adding: Promise<void> | undefined;

      const stop = onFirstNotification(list, watch, () => {
        adding = list.add(9, async () => 90);
      });

      const removing = list.remove(
        (value) => value === 2,
        () => removingGate.promise,
      );

      await adding;
      expect(list.items()).toEqual([1, 3, 90]);

      removingGate.resolve();
      await removing;
      stop();

      expect(list.items()).toEqual([1, 3, 90]);
      expect(list.pending()).toBe(false);
    });
  }

  it("remove() keeps a row added by a reentrant PREDICATE", async () => {
    // The predicate runs during PREPARE, before anything is committed. The new
    // row must survive the commit, which is why the commit recomputes the order
    // from the live list rather than from a snapshot taken during preparation.
    const list = optimisticList([1, 2, 3]);
    const g = gate<void>();
    let adding: Promise<void> | undefined;
    let fired = false;

    const removing = list.remove(
      (value) => {
        if (!fired) {
          fired = true;
          adding = list.add(9, async () => 90);
        }
        return value === 2;
      },
      () => g.promise,
    );

    await adding;
    expect(list.items()).toEqual([1, 3, 90]);
    g.resolve();
    await removing;
    expect(list.items()).toEqual([1, 3, 90]);
  });

  it("a CONFIRMED deletion is not undone by another failed remove", async () => {
    // Found in the final review pass. A predicate re-enters the list and removes
    // a row the outer predicate is still scanning for, so both operations match
    // it. The inner deletion is confirmed by the server; the outer one fails.
    // Its rollback must not bring back a row whose deletion actually happened.
    const list = optimisticList([1, 2, 3]);
    const outerGate = gate<void>();
    let inner: Promise<void> | undefined;
    let fired = false;

    const outer = list.remove(
      (v) => {
        if (!fired) {
          fired = true;
          inner = list.remove(
            (x) => x === 2,
            async () => {},
          );
        }
        return v === 2;
      },
      () => outerGate.promise,
    );

    await inner;
    expect(list.items()).toEqual([1, 3]);

    outerGate.reject(new Error("outer failed"));
    await outer;

    expect(list.items(), "a confirmed deletion was resurrected").toEqual([1, 3]);
    expect(list.pending()).toBe(false);
  });

  it("a FAILED deletion is still restored when another remove also matched", async () => {
    // The mirror case, proving the retirement is narrow: when neither remove
    // succeeded, the row must come back exactly once.
    const list = optimisticList([1, 2, 3]);
    const outerGate = gate<void>();
    const innerGate = gate<void>();
    let inner: Promise<void> | undefined;
    let fired = false;

    const outer = list.remove(
      (v) => {
        if (!fired) {
          fired = true;
          inner = list.remove(
            (x) => x === 2,
            () => innerGate.promise,
          );
        }
        return v === 2;
      },
      () => outerGate.promise,
    );

    innerGate.reject(new Error("inner failed"));
    await inner;
    expect(list.items()).toEqual([1, 2, 3]);

    outerGate.reject(new Error("outer failed"));
    await outer;

    expect(list.items(), "the row was restored twice").toEqual([1, 2, 3]);
    expect(list.pending()).toBe(false);
  });

  it("a subscriber's remove() is not undone by the outer add()", async () => {
    const list = optimisticList([1, 2, 3]);
    const addGate = gate<number>();
    let removing: Promise<void> | undefined;

    const stop = onFirstNotification(list, "pending", () => {
      removing = list.remove(
        (v) => v === 1,
        async () => {},
      );
    });

    const adding = list.add(4, () => addGate.promise);
    await removing;
    expect(list.items()).toEqual([2, 3, 4]);

    addGate.resolve(40);
    await adding;
    stop();

    expect(list.items()).toEqual([2, 3, 40]);
    expect(list.pending()).toBe(false);
  });
});

// ─── Failure B: latest owner wins, including under reentrancy ───────────────

describe("an older operation cannot reclaim ownership from a newer reentrant one", () => {
  for (const watch of ["pending", "items", "both"] as const) {
    it(`update() yields the row to a reentrant update (watching ${watch})`, async () => {
      const list = optimisticList<Item>([{ id: 1, value: "initial" }]);
      const olderGate = gate<Item>();
      const newerGate = gate<Item>();
      let newer: Promise<void> | undefined;

      const stop = onFirstNotification(list, watch, () => {
        newer = list.update(
          (item) => item.id === 1,
          { value: "newer optimistic" },
          () => newerGate.promise,
        );
      });

      const older = list.update(
        (item) => item.id === 1,
        { value: "older optimistic" },
        () => olderGate.promise,
      );

      newerGate.resolve({ id: 1, value: "newer confirmed" });
      await newer;
      expect(list.items()).toEqual([{ id: 1, value: "newer confirmed" }]);

      olderGate.resolve({ id: 1, value: "older confirmed" });
      await older;
      stop();

      expect(list.items()).toEqual([{ id: 1, value: "newer confirmed" }]);
      expect(list.pending()).toBe(false);
    });
  }

  it("an older FAILURE does not revert a newer reentrant update", async () => {
    const list = optimisticList<Item>([{ id: 1, value: "initial" }]);
    const olderGate = gate<Item>();
    const newerGate = gate<Item>();
    let newer: Promise<void> | undefined;

    const stop = onFirstNotification(list, "pending", () => {
      newer = list.update(
        (i) => i.id === 1,
        { value: "newer" },
        () => newerGate.promise,
      );
    });

    const older = list.update(
      (i) => i.id === 1,
      { value: "older" },
      () => olderGate.promise,
    );

    newerGate.resolve({ id: 1, value: "newer confirmed" });
    await newer;
    olderGate.reject(new Error("older failed"));
    await older;
    stop();

    expect(list.items()).toEqual([{ id: 1, value: "newer confirmed" }]);
  });

  it("a newer FAILURE hands the row back to the older operation", async () => {
    const list = optimisticList<Item>([{ id: 1, value: "initial" }]);
    const olderGate = gate<Item>();
    const newerGate = gate<Item>();
    let newer: Promise<void> | undefined;

    const stop = onFirstNotification(list, "pending", () => {
      newer = list.update(
        (i) => i.id === 1,
        { value: "newer" },
        () => newerGate.promise,
      );
    });

    const older = list.update(
      (i) => i.id === 1,
      { value: "older" },
      () => olderGate.promise,
    );

    newerGate.reject(new Error("newer failed"));
    await newer;
    // The newer failure reverts to what IT found — the older optimistic value —
    // and returns ownership to the older operation.
    expect(list.items()).toEqual([{ id: 1, value: "older" }]);

    olderGate.resolve({ id: 1, value: "older confirmed" });
    await older;
    stop();
    expect(list.items()).toEqual([{ id: 1, value: "older confirmed" }]);
  });

  it("both reentrant operations failing returns the original value", async () => {
    const list = optimisticList<Item>([{ id: 1, value: "initial" }]);
    const olderGate = gate<Item>();
    const newerGate = gate<Item>();
    let newer: Promise<void> | undefined;

    const stop = onFirstNotification(list, "pending", () => {
      newer = list.update(
        (i) => i.id === 1,
        { value: "newer" },
        () => newerGate.promise,
      );
    });

    const older = list.update(
      (i) => i.id === 1,
      { value: "older" },
      () => olderGate.promise,
    );

    newerGate.reject(new Error("newer"));
    await newer;
    olderGate.reject(new Error("older"));
    await older;
    stop();

    expect(list.items()).toEqual([{ id: 1, value: "initial" }]);
    expect(list.pending()).toBe(false);
  });

  it("reentrant operations on DISJOINT rows settle independently", async () => {
    const list = optimisticList<Item>([
      { id: 1, value: "a" },
      { id: 2, value: "b" },
    ]);
    const outerGate = gate<Item>();
    const innerGate = gate<Item>();
    let inner: Promise<void> | undefined;

    const stop = onFirstNotification(list, "pending", () => {
      inner = list.update(
        (i) => i.id === 2,
        { value: "B" },
        () => innerGate.promise,
      );
    });

    const outer = list.update(
      (i) => i.id === 1,
      { value: "A" },
      () => outerGate.promise,
    );

    outerGate.reject(new Error("outer failed"));
    await outer;
    innerGate.resolve({ id: 2, value: "B confirmed" });
    await inner;
    stop();

    expect(list.items()).toEqual([
      { id: 1, value: "a" },
      { id: 2, value: "B confirmed" },
    ]);
  });

  it("a reentrant update claims a row the outer remove has hidden", async () => {
    const list = optimisticList<Item>([{ id: 1, value: "initial" }]);
    const removeGate = gate<void>();
    const updateGate = gate<Item>();
    let updating: Promise<void> | undefined;

    const stop = onFirstNotification(list, "pending", () => {
      // The row is already hidden by the outer remove at this point, so the
      // predicate matches nothing — the update is a no-op on zero rows.
      updating = list.update(
        (i) => i.id === 1,
        { value: "never" },
        () => updateGate.promise,
      );
    });

    const removing = list.remove(
      (i) => i.id === 1,
      () => removeGate.promise,
    );

    updateGate.resolve({ id: 1, value: "unused" });
    await updating;
    removeGate.reject(new Error("remove failed"));
    await removing;
    stop();

    // The hidden row returns untouched: the reentrant update matched nothing.
    expect(list.items()).toEqual([{ id: 1, value: "initial" }]);
    expect(list.pending()).toBe(false);
  });

  it("duplicate primitives stay independently addressable under reentrancy", async () => {
    const list = optimisticList<number>([7, 7]);
    const outerGate = gate<void>();
    let inner: Promise<void> | undefined;

    const stop = onFirstNotification(list, "pending", () => {
      inner = list.add(7, async () => 77);
    });

    const outer = list.remove(
      (v) => v === 7,
      () => outerGate.promise,
    );

    await inner;
    expect(list.items()).toEqual([77]);

    outerGate.reject(new Error("remove failed"));
    await outer;
    stop();

    expect(list.items()).toEqual([7, 7, 77]);
  });

  it("duplicate object references stay independently addressable under reentrancy", async () => {
    const shared = { id: 1, value: "s" };
    const list = optimisticList<Item>([shared, shared]);
    const outerGate = gate<Item>();
    let inner: Promise<void> | undefined;

    const stop = onFirstNotification(list, "pending", () => {
      inner = list.add(shared, async () => ({ id: 9, value: "added" }));
    });

    const outer = list.update(
      (i) => i === shared,
      { value: "patched" },
      () => outerGate.promise,
    );

    await inner;
    outerGate.resolve({ id: 1, value: "confirmed" });
    await outer;
    stop();

    // Both original occurrences were matched and confirmed; the reentrant add
    // landed in its own row and is untouched by the outer update.
    expect(list.items()).toEqual([
      { id: 1, value: "confirmed" },
      { id: 1, value: "confirmed" },
      { id: 9, value: "added" },
    ]);
  });

  it("a reentrant REMOVE hides a row the outer update just claimed", async () => {
    // The mirror of the previous case, and the one the settlement matrix does
    // not reach: the inner operation takes the row off screen while the outer
    // one still owns its value.
    const list = optimisticList<Item>([{ id: 1, value: "initial" }]);
    const updateGate = gate<Item>();
    const removeGate = gate<void>();
    let removing: Promise<void> | undefined;

    const stop = onFirstNotification(list, "pending", () => {
      removing = list.remove(
        (i) => i.id === 1,
        () => removeGate.promise,
      );
    });

    const updating = list.update(
      (i) => i.id === 1,
      { value: "optimistic" },
      () => updateGate.promise,
    );

    await Promise.resolve();
    expect(list.items()).toEqual([]);

    updateGate.resolve({ id: 1, value: "confirmed" });
    await updating;
    // Still hidden, so nothing visible changed…
    expect(list.items()).toEqual([]);

    removeGate.reject(new Error("remove failed"));
    await removing;
    stop();

    // …but the row returns carrying the value the outer update confirmed while
    // it was off screen.
    expect(list.items()).toEqual([{ id: 1, value: "confirmed" }]);
    expect(list.pending()).toBe(false);
  });

  it("a reentrant remove that SUCCEEDS retires the row despite the outer update", async () => {
    const list = optimisticList<Item>([{ id: 1, value: "initial" }]);
    const updateGate = gate<Item>();
    let removing: Promise<void> | undefined;

    const stop = onFirstNotification(list, "pending", () => {
      removing = list.remove(
        (i) => i.id === 1,
        async () => {},
      );
    });

    const updating = list.update(
      (i) => i.id === 1,
      { value: "optimistic" },
      () => updateGate.promise,
    );

    await removing;
    updateGate.resolve({ id: 1, value: "confirmed" });
    await updating;
    stop();

    expect(list.items()).toEqual([]);
    expect(list.pending()).toBe(false);

    // The list is still fully usable — nothing was left in a half-retired state.
    const d = gate<Item>();
    const adding = list.add({ id: 2, value: "fresh" }, () => d.promise);
    d.resolve({ id: 2, value: "fresh confirmed" });
    await adding;
    expect(list.items()).toEqual([{ id: 2, value: "fresh confirmed" }]);
  });

  it("reference counting survives many overlapping reentrant operations", async () => {
    // Every `retain` must have exactly one `release`. A miscount either retires
    // a row another operation still needs (rows vanish) or never retires one
    // (unbounded growth). Neither is directly observable, so this drives heavy
    // overlapping traffic and asserts the list stays exactly correct and idle.
    //
    // The subscriber watches `items`, not `pending`. `pending` is a boolean, so
    // it only notifies on TRANSITIONS — with the long-lived operation below
    // holding it true throughout, a `pending`-only subscriber would never be
    // woken again. That is correct signal behaviour, not a defect, but it makes
    // `pending` the wrong trigger for a test that needs one wake-up per round.
    const list = optimisticList<number>([0]);
    const held = gate<number>();
    const holding = list.add(-1, () => held.promise);

    for (let round = 0; round < 40; round++) {
      let inner: Promise<void> | undefined;
      const stop = onFirstNotification(list, "items", () => {
        inner = list.add(round * 10 + 1, async () => round * 10 + 1);
      });

      const outerGate = gate<number>();
      const outer = list.add(round * 10, () => outerGate.promise);
      await inner;
      outerGate.reject(new Error("outer fails"));
      await outer;
      stop();
      expect(list.pending(), "the long-lived operation settled early").toBe(true);
    }

    held.resolve(-100);
    await holding;
    expect(list.pending()).toBe(false);

    // Every failed outer add withdrew exactly its own row; every reentrant add
    // survived, in creation order.
    const expected = [0, -100, ...Array.from({ length: 40 }, (_, i) => i * 10 + 1)];
    expect(list.items()).toEqual(expected);
  });

  it("an operation matching zero rows still settles cleanly", async () => {
    const list = optimisticList<Item>([{ id: 1, value: "a" }]);
    const g = gate<Item>();
    let inner: Promise<void> | undefined;

    const stop = onFirstNotification(list, "pending", () => {
      inner = list.update(
        (i) => i.id === 999,
        { value: "no" },
        () => g.promise,
      );
    });

    const outer = list.update(
      (i) => i.id === 999,
      { value: "also no" },
      async () => ({ id: 999, value: "x" }),
    );

    await outer;
    g.resolve({ id: 999, value: "y" });
    await inner;
    stop();

    expect(list.items()).toEqual([{ id: 1, value: "a" }]);
    expect(list.pending()).toBe(false);
  });
});

// ─── Failure C: exception safety in the preparation phase ───────────────────

describe("hostile user code during preparation mutates nothing", () => {
  it("a throwing patch getter leaves the list untouched and idle", async () => {
    const list = optimisticList<Item>([{ id: 1, value: "initial" }]);
    const patch = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        throw new Error("patch getter failed");
      },
    }) as Partial<Item>;

    await expect(
      list.update(
        (item) => item.id === 1,
        patch,
        async () => ({ id: 1, value: "never" }),
      ),
    ).rejects.toThrow("patch getter failed");

    expect(list.pending()).toBe(false);
    expect(list.items()).toEqual([{ id: 1, value: "initial" }]);
  });

  it("leaves no ownership or reference state behind", async () => {
    const list = optimisticList<Item>([{ id: 1, value: "initial" }]);
    const patch = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        throw new Error("patch getter failed");
      },
    }) as Partial<Item>;

    await expect(
      list.update(
        (i) => i.id === 1,
        patch,
        async () => ({ id: 1, value: "never" }),
      ),
    ).rejects.toThrow();

    // If a reference had been retained or an owner assigned, this later
    // operation on the same row would be suppressed or mis-settled.
    const d = gate<Item>();
    const p = list.update(
      (i) => i.id === 1,
      { value: "second" },
      () => d.promise,
    );
    expect(list.items()).toEqual([{ id: 1, value: "second" }]);
    expect(list.pending()).toBe(true);
    d.resolve({ id: 1, value: "second confirmed" });
    await p;

    expect(list.items()).toEqual([{ id: 1, value: "second confirmed" }]);
    expect(list.pending()).toBe(false);

    // …and the row can still be removed and restored normally.
    const r = gate<void>();
    const removing = list.remove(
      (i) => i.id === 1,
      () => r.promise,
    );
    expect(list.items()).toEqual([]);
    r.reject(new Error("nope"));
    await removing;
    expect(list.items()).toEqual([{ id: 1, value: "second confirmed" }]);
  });

  it("a patch getter that throws AFTER an earlier row prepared leaves both untouched", async () => {
    const list = optimisticList<Item>([
      { id: 1, value: "one" },
      { id: 2, value: "two" },
    ]);
    let reads = 0;
    const patch = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        reads++;
        if (reads > 1) throw new Error("second read failed");
        return "patched";
      },
    }) as Partial<Item>;

    await expect(
      list.update(
        () => true,
        patch,
        async () => ({ id: 0, value: "never" }),
      ),
    ).rejects.toThrow("second read failed");

    // The first row was prepared successfully before the throw. Because
    // preparation mutates nothing, it is untouched too.
    expect(list.items()).toEqual([
      { id: 1, value: "one" },
      { id: 2, value: "two" },
    ]);
    expect(list.pending()).toBe(false);
  });

  it("a throwing predicate leaves the list untouched and idle", async () => {
    const list = optimisticList<Item>([{ id: 1, value: "initial" }]);
    const boom = new Error("predicate failed");

    await expect(
      list.remove(
        () => {
          throw boom;
        },
        async () => {},
      ),
    ).rejects.toBe(boom);
    expect(list.pending()).toBe(false);
    expect(list.items()).toEqual([{ id: 1, value: "initial" }]);

    await expect(
      list.update(
        () => {
          throw boom;
        },
        { value: "x" },
        async () => ({ id: 1, value: "y" }),
      ),
    ).rejects.toBe(boom);
    expect(list.pending()).toBe(false);
    expect(list.items()).toEqual([{ id: 1, value: "initial" }]);
  });

  it("a synchronously throwing asyncAction is contained like any failure", async () => {
    const list = optimisticList<Item>([{ id: 1, value: "initial" }]);

    await list.update(
      (i) => i.id === 1,
      { value: "optimistic" },
      () => {
        throw new Error("sync action throw");
      },
    );

    expect(list.items()).toEqual([{ id: 1, value: "initial" }]);
    expect(list.pending()).toBe(false);
  });

  it("a synchronously rejected promise is contained like any failure", async () => {
    const list = optimisticList<number>([1]);
    await list.add(2, () => Promise.reject(new Error("rejected")));
    expect(list.items()).toEqual([1]);
    expect(list.pending()).toBe(false);
  });

  it("no unhandled rejection escapes any reentrant or hostile path", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const list = optimisticList<Item>([{ id: 1, value: "a" }]);
      let inner: Promise<void> | undefined;
      const stop = onFirstNotification(list, "both", () => {
        inner = list.update(
          (i) => i.id === 1,
          { value: "inner" },
          () => Promise.reject(new Error("inner failed")),
        );
      });

      await list.update(
        (i) => i.id === 1,
        { value: "outer" },
        () => Promise.reject(new Error("outer failed")),
      );
      await inner;
      stop();

      await tick();
      await tick();
      expect(seen).toEqual([]);
      expect(list.items()).toEqual([{ id: 1, value: "a" }]);
      expect(list.pending()).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// ─── settlement-order matrix over reentrant pairs ───────────────────────────

describe("reentrant pairs settle correctly in every order", () => {
  type Outcome = "ok" | "fail";

  async function run(outerKind: "add" | "remove" | "update", outerFirst: boolean, o: Outcome, i: Outcome) {
    const list = optimisticList<Item>([
      { id: 1, value: "a" },
      { id: 2, value: "b" },
    ]);
    const outerGate = gate<Item>();
    const innerGate = gate<Item>();
    let inner: Promise<void> | undefined;

    const stop = onFirstNotification(list, "pending", () => {
      inner = list.update(
        (x) => x.id === 2,
        { value: "inner" },
        () => innerGate.promise,
      );
    });

    let outer: Promise<void>;
    if (outerKind === "add") outer = list.add({ id: 3, value: "c" }, () => outerGate.promise as Promise<Item>);
    else if (outerKind === "remove")
      outer = list.remove(
        (x) => x.id === 1,
        () => outerGate.promise as unknown as Promise<void>,
      );
    else
      outer = list.update(
        (x) => x.id === 1,
        { value: "outer" },
        () => outerGate.promise,
      );

    const settleOuter = () =>
      o === "ok" ? outerGate.resolve({ id: 1, value: "outer confirmed" }) : outerGate.reject(new Error("outer"));
    const settleInner = () =>
      i === "ok" ? innerGate.resolve({ id: 2, value: "inner confirmed" }) : innerGate.reject(new Error("inner"));

    if (outerFirst) {
      settleOuter();
      await outer;
      settleInner();
      await inner;
    } else {
      settleInner();
      await inner;
      settleOuter();
      await outer;
    }
    stop();

    expect(list.pending(), "the list did not return to idle").toBe(false);
    // Row 2 belongs to the inner operation in every ordering.
    const row2 = list.items().find((x) => x.id === 2);
    expect(row2, "row 2 disappeared").toBeDefined();
    expect(row2?.value).toBe(i === "ok" ? "inner confirmed" : "b");
    return list.items();
  }

  for (const outerKind of ["add", "remove", "update"] as const) {
    for (const outerFirst of [true, false]) {
      for (const o of ["ok", "fail"] as const) {
        for (const i of ["ok", "fail"] as const) {
          it(`outer ${outerKind} (${o}) / inner update (${i}), ${outerFirst ? "outer" : "inner"} settles first`, async () => {
            await run(outerKind, outerFirst, o, i);
          });
        }
      }
    }
  }
});
