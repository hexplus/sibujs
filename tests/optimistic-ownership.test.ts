/**
 * `optimisticList()` operation ownership under concurrent settlement.
 *
 * WHAT WAS WRONG
 * --------------
 * The previous implementation captured the whole array before each operation and
 * guarded the rollback with a single global version counter:
 *
 *     end(myVersion, () => setItems(prev));   // only when version === myVersion
 *
 * Both branches of that are wrong. Skipping the rollback leaves a failed
 * operation's optimistic artifact on screen forever — given `[1,2,3]`, `add(4)`
 * then `add(5)`, a failure of the first add produced `[1,2,3,4,5]`, keeping an
 * item that demonstrably failed to save because a *different* row was saved
 * after it. Running the rollback is no better: restoring the captured array
 * discards everything newer operations did to rows the failing one never
 * touched.
 *
 * A global counter cannot choose between those, because "is there a newer
 * operation" is the wrong question. The right question is per row: does this
 * operation still own what it is about to change?
 *
 * HOW THESE TESTS ARE WRITTEN
 * ---------------------------
 * Every operation is driven by an explicitly controlled deferred, so settlement
 * order is chosen by the test rather than by timing. Every assertion states the
 * COMPLETE ordered array — `toContain()` would pass while the failed item was
 * still present, which is the exact bug.
 */

import { describe, expect, it } from "vitest";
import { optimisticList } from "../src/patterns/optimistic";
import { createDeferred } from "./helpers/mocks";

/** A deferred whose rejection is always handled, so tests never leak one. */
function gate<T = void>() {
  const d = createDeferred<T>();
  d.promise.catch(() => {});
  return d;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

interface Todo {
  id: number;
  text: string;
}

describe("optimisticList — concurrent add ownership", () => {
  it("1. older add fails, newer add succeeds", async () => {
    const list = optimisticList<number>([1, 2, 3]);
    const a = gate<number>();
    const b = gate<number>();

    const pa = list.add(4, () => a.promise);
    const pb = list.add(5, () => b.promise);
    expect(list.items()).toEqual([1, 2, 3, 4, 5]);

    a.reject(new Error("A failed"));
    await pa;
    // The failed row is gone; the newer pending row is untouched.
    expect(list.items()).toEqual([1, 2, 3, 5]);

    b.resolve(50);
    await pb;
    expect(list.items()).toEqual([1, 2, 3, 50]);
  });

  it("2. newer add succeeds first, older add fails late", async () => {
    const list = optimisticList<number>([1]);
    const a = gate<number>();
    const b = gate<number>();

    const pa = list.add(2, () => a.promise);
    const pb = list.add(3, () => b.promise);

    b.resolve(30);
    await pb;
    expect(list.items()).toEqual([1, 2, 30]);

    a.reject(new Error("A failed"));
    await pa;
    // Only A's own row is withdrawn. B's confirmed value stays exactly where it is.
    expect(list.items()).toEqual([1, 30]);
  });

  it("3. older add succeeds late after a newer add", async () => {
    const list = optimisticList<number>([1]);
    const a = gate<number>();
    const b = gate<number>();

    const pa = list.add(2, () => a.promise);
    const pb = list.add(3, () => b.promise);

    b.resolve(30);
    await pb;
    a.resolve(20);
    await pa;

    // Each add published into its OWN row, so insertion order is preserved
    // regardless of settlement order.
    expect(list.items()).toEqual([1, 20, 30]);
  });

  it("4a. both concurrent adds fail, older first", async () => {
    const list = optimisticList<number>([1]);
    const a = gate<number>();
    const b = gate<number>();
    const pa = list.add(2, () => a.promise);
    const pb = list.add(3, () => b.promise);

    a.reject(new Error("A"));
    await pa;
    expect(list.items()).toEqual([1, 3]);

    b.reject(new Error("B"));
    await pb;
    expect(list.items()).toEqual([1]);
    expect(list.pending()).toBe(false);
  });

  it("4b. both concurrent adds fail, newer first", async () => {
    const list = optimisticList<number>([1]);
    const a = gate<number>();
    const b = gate<number>();
    const pa = list.add(2, () => a.promise);
    const pb = list.add(3, () => b.promise);

    b.reject(new Error("B"));
    await pb;
    expect(list.items()).toEqual([1, 2]);

    a.reject(new Error("A"));
    await pa;
    expect(list.items()).toEqual([1]);
    expect(list.pending()).toBe(false);
  });
});

describe("optimisticList — row identity", () => {
  it("5. duplicate primitive already exists; the OPTIMISTIC one is replaced", async () => {
    // The old lookup fell back to `Object.is`, which found the pre-existing `1`
    // at index 0 and produced `[10, 1]`.
    const list = optimisticList<number>([1]);
    const d = gate<number>();
    const p = list.add(1, () => d.promise);
    expect(list.items()).toEqual([1, 1]);

    d.resolve(10);
    await p;
    expect(list.items()).toEqual([1, 10]);
  });

  it("6. two identical primitive optimistic adds settle in reverse order", async () => {
    const list = optimisticList<number>([]);
    const a = gate<number>();
    const b = gate<number>();
    const pa = list.add(7, () => a.promise);
    const pb = list.add(7, () => b.promise);
    expect(list.items()).toEqual([7, 7]);

    b.resolve(72);
    await pb;
    expect(list.items()).toEqual([7, 72]);

    a.resolve(71);
    await pa;
    expect(list.items()).toEqual([71, 72]);
  });

  it("6b. one of two identical primitives fails; only that row goes", async () => {
    const list = optimisticList<number>([]);
    const a = gate<number>();
    const b = gate<number>();
    const pa = list.add(7, () => a.promise);
    const pb = list.add(7, () => b.promise);

    a.reject(new Error("A"));
    await pa;
    expect(list.items()).toEqual([7]);

    b.resolve(72);
    await pb;
    expect(list.items()).toEqual([72]);
  });

  it("7. duplicate object references remain distinguishable", async () => {
    const shared = { id: 1 };
    const list = optimisticList<{ id: number }>([shared]);
    const d = gate<{ id: number }>();
    const p = list.add(shared, () => d.promise);
    expect(list.items()).toEqual([shared, shared]);

    d.resolve({ id: 99 });
    await p;
    // The pre-existing occurrence of the SAME reference is untouched.
    expect(list.items()).toEqual([{ id: 1 }, { id: 99 }]);
  });

  it("7b. a failed add of a duplicate reference removes only its own row", async () => {
    const shared = { id: 1 };
    const list = optimisticList<{ id: number }>([shared]);
    const d = gate<{ id: number }>();
    const p = list.add(shared, () => d.promise);

    d.reject(new Error("nope"));
    await p;
    expect(list.items()).toEqual([{ id: 1 }]);
    expect(list.items()[0]).toBe(shared);
  });
});

describe("optimisticList — remove ownership", () => {
  it("8. failed remove concurrent with a successful add", async () => {
    const list = optimisticList<number>([1, 2, 3]);
    const r = gate<void>();
    const a = gate<number>();

    const pr = list.remove(
      (n) => n === 2,
      () => r.promise,
    );
    const pa = list.add(4, () => a.promise);
    expect(list.items()).toEqual([1, 3, 4]);

    a.resolve(40);
    await pa;
    expect(list.items()).toEqual([1, 3, 40]);

    r.reject(new Error("remove failed"));
    await pr;
    // `2` is reinstated at its original index; the newer add is untouched.
    expect(list.items()).toEqual([1, 2, 3, 40]);
  });

  it("9. failed remove concurrent with another remove", async () => {
    const list = optimisticList<number>([1, 2, 3, 4]);
    const r1 = gate<void>();
    const r2 = gate<void>();

    const p1 = list.remove(
      (n) => n === 2,
      () => r1.promise,
    );
    const p2 = list.remove(
      (n) => n === 4,
      () => r2.promise,
    );
    expect(list.items()).toEqual([1, 3]);

    r2.resolve();
    await p2;
    expect(list.items()).toEqual([1, 3]);

    r1.reject(new Error("r1 failed"));
    await p1;
    // Only r1's row comes back. r2's succeeded removal is not resurrected.
    expect(list.items()).toEqual([1, 2, 3]);
  });

  it("9b. both removes fail, settling in reverse order", async () => {
    const list = optimisticList<number>([1, 2, 3, 4]);
    const r1 = gate<void>();
    const r2 = gate<void>();
    const p1 = list.remove(
      (n) => n === 2,
      () => r1.promise,
    );
    const p2 = list.remove(
      (n) => n === 4,
      () => r2.promise,
    );

    r2.reject(new Error("r2"));
    await p2;
    expect(list.items()).toEqual([1, 3, 4]);

    r1.reject(new Error("r1"));
    await p1;
    expect(list.items()).toEqual([1, 2, 3, 4]);
  });

  it("a failed remove does not resurrect a row whose add also failed", async () => {
    // Found in self-review. The remove captured a row created by a still-pending
    // add. When both fail, reinstating that row would put an item on screen that
    // was never persisted — a failed operation's artifact reappearing by way of
    // a second operation's rollback.
    const list = optimisticList<number>([1]);
    const a = gate<number>();
    const r = gate<void>();

    const pa = list.add(2, () => a.promise);
    expect(list.items()).toEqual([1, 2]);
    const pr = list.remove(
      (n) => n === 2,
      () => r.promise,
    );
    expect(list.items()).toEqual([1]);

    a.reject(new Error("add failed"));
    await pa;
    r.reject(new Error("remove failed"));
    await pr;

    expect(list.items(), "a phantom row came back").toEqual([1]);
    expect(list.pending()).toBe(false);
  });

  it("a failed remove DOES restore a row whose add succeeded", async () => {
    // The mirror case, to prove the revocation is narrow rather than a blanket
    // suppression of the rollback.
    const list = optimisticList<number>([1]);
    const a = gate<number>();
    const r = gate<void>();

    const pa = list.add(2, () => a.promise);
    const pr = list.remove(
      (n) => n === 2,
      () => r.promise,
    );

    a.resolve(20);
    await pa;
    r.reject(new Error("remove failed"));
    await pr;

    expect(list.items()).toEqual([1, 2]);
  });

  it("two failed removes of the same row restore it exactly once", async () => {
    const list = optimisticList<number>([1, 2, 3]);
    const r1 = gate<void>();
    const r2 = gate<void>();

    const p1 = list.remove(
      (n) => n === 2,
      () => r1.promise,
    );
    // The second remove finds nothing to take out — the row is already gone.
    const p2 = list.remove(
      (n) => n === 2,
      () => r2.promise,
    );
    expect(list.items()).toEqual([1, 3]);

    r1.reject(new Error("r1"));
    await p1;
    expect(list.items()).toEqual([1, 2, 3]);

    r2.reject(new Error("r2"));
    await p2;
    expect(list.items(), "the row was restored twice").toEqual([1, 2, 3]);
  });

  it("a successful remove does not alter unrelated later changes", async () => {
    const list = optimisticList<number>([1, 2, 3]);
    const r = gate<void>();
    const a = gate<number>();
    const pr = list.remove(
      (n) => n === 1,
      () => r.promise,
    );
    const pa = list.add(9, () => a.promise);

    a.resolve(90);
    await pa;
    r.resolve();
    await pr;

    expect(list.items()).toEqual([2, 3, 90]);
  });

  it("a failed remove of several rows restores all of them in order", async () => {
    const list = optimisticList<number>([1, 2, 3, 4, 5]);
    const r = gate<void>();
    const p = list.remove(
      (n) => n % 2 === 0,
      () => r.promise,
    );
    expect(list.items()).toEqual([1, 3, 5]);

    r.reject(new Error("nope"));
    await p;
    expect(list.items()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("optimisticList — update ownership", () => {
  const seed = (): Todo[] => [
    { id: 1, text: "a" },
    { id: 2, text: "b" },
  ];

  it("10. failed update concurrent with an update to a different row", async () => {
    const list = optimisticList<Todo>(seed());
    const u1 = gate<Todo>();
    const u2 = gate<Todo>();

    const p1 = list.update(
      (t) => t.id === 1,
      { text: "A" },
      () => u1.promise,
    );
    const p2 = list.update(
      (t) => t.id === 2,
      { text: "B" },
      () => u2.promise,
    );
    expect(list.items()).toEqual([
      { id: 1, text: "A" },
      { id: 2, text: "B" },
    ]);

    u2.resolve({ id: 2, text: "B!" });
    await p2;
    u1.reject(new Error("u1 failed"));
    await p1;

    // Row 1 reverts to its own previous value; row 2 keeps its confirmed one.
    expect(list.items()).toEqual([
      { id: 1, text: "a" },
      { id: 2, text: "B!" },
    ]);
  });

  it("11. two updates to the same row settle in reverse order", async () => {
    const list = optimisticList<Todo>(seed());
    const u1 = gate<Todo>();
    const u2 = gate<Todo>();

    const p1 = list.update(
      (t) => t.id === 1,
      { text: "first" },
      () => u1.promise,
    );
    const p2 = list.update(
      (t) => t.id === 1,
      { text: "second" },
      () => u2.promise,
    );
    expect(list.items()[0]).toEqual({ id: 1, text: "second" });

    u2.resolve({ id: 1, text: "second!" });
    await p2;
    expect(list.items()[0]).toEqual({ id: 1, text: "second!" });

    u1.resolve({ id: 1, text: "first!" });
    await p1;
    // The later operation owns the row; the older success is a no-op for it.
    expect(list.items()).toEqual([
      { id: 1, text: "second!" },
      { id: 2, text: "b" },
    ]);
  });

  it("12. older update fails after a newer update succeeded on the same row", async () => {
    const list = optimisticList<Todo>(seed());
    const u1 = gate<Todo>();
    const u2 = gate<Todo>();

    const p1 = list.update(
      (t) => t.id === 1,
      { text: "first" },
      () => u1.promise,
    );
    const p2 = list.update(
      (t) => t.id === 1,
      { text: "second" },
      () => u2.promise,
    );

    u2.resolve({ id: 1, text: "second!" });
    await p2;
    u1.reject(new Error("u1 failed"));
    await p1;

    // The older failure must NOT revert the newer, confirmed value.
    expect(list.items()).toEqual([
      { id: 1, text: "second!" },
      { id: 2, text: "b" },
    ]);
  });

  it("12b. newer update fails after an older update succeeded on the same row", async () => {
    const list = optimisticList<Todo>(seed());
    const u1 = gate<Todo>();
    const u2 = gate<Todo>();

    const p1 = list.update(
      (t) => t.id === 1,
      { text: "first" },
      () => u1.promise,
    );
    const p2 = list.update(
      (t) => t.id === 1,
      { text: "second" },
      () => u2.promise,
    );

    u1.resolve({ id: 1, text: "first!" });
    await p1;
    // The older success is suppressed: row 1 is owned by the newer update.
    expect(list.items()[0]).toEqual({ id: 1, text: "second" });

    u2.reject(new Error("u2 failed"));
    await p2;
    // The newer failure reverts to what IT found — the older optimistic value —
    // and hands ownership back to the older operation.
    expect(list.items()).toEqual([
      { id: 1, text: "first" },
      { id: 2, text: "b" },
    ]);
  });

  it("a failed update does not resurrect a row removed since", async () => {
    const list = optimisticList<Todo>(seed());
    const u = gate<Todo>();
    const r = gate<void>();

    const pu = list.update(
      (t) => t.id === 1,
      { text: "A" },
      () => u.promise,
    );
    const pr = list.remove(
      (t) => t.id === 1,
      () => r.promise,
    );
    expect(list.items()).toEqual([{ id: 2, text: "b" }]);

    r.resolve();
    await pr;
    u.reject(new Error("u failed"));
    await pu;

    expect(list.items()).toEqual([{ id: 2, text: "b" }]);
  });

  it("a successful update publishes to every row it still owns", async () => {
    const list = optimisticList<Todo>([
      { id: 1, text: "x" },
      { id: 2, text: "x" },
    ]);
    const u = gate<Todo>();
    const p = list.update(
      (t) => t.text === "x",
      { text: "y" },
      () => u.promise,
    );

    u.resolve({ id: 0, text: "confirmed" });
    await p;
    expect(list.items()).toEqual([
      { id: 0, text: "confirmed" },
      { id: 0, text: "confirmed" },
    ]);
  });
});

describe("optimisticList — pending and bookkeeping", () => {
  it("13. pending stays true until every operation settles", async () => {
    const list = optimisticList<number>([1]);
    const a = gate<number>();
    const b = gate<number>();
    const c = gate<void>();

    expect(list.pending()).toBe(false);
    const pa = list.add(2, () => a.promise);
    expect(list.pending()).toBe(true);
    const pb = list.add(3, () => b.promise);
    const pc = list.remove(
      (n) => n === 1,
      () => c.promise,
    );
    expect(list.pending()).toBe(true);

    b.resolve(30);
    await pb;
    expect(list.pending()).toBe(true);

    c.reject(new Error("c"));
    await pc;
    expect(list.pending()).toBe(true);

    a.resolve(20);
    await pa;
    expect(list.pending()).toBe(false);
  });

  it("13b. pending returns to false when every operation fails", async () => {
    const list = optimisticList<number>([1]);
    const a = gate<number>();
    const b = gate<number>();
    const pa = list.add(2, () => a.promise);
    const pb = list.add(3, () => b.promise);

    b.reject(new Error("b"));
    await pb;
    expect(list.pending()).toBe(true);
    a.reject(new Error("a"));
    await pa;
    expect(list.pending()).toBe(false);
    expect(list.items()).toEqual([1]);
  });

  it("14. no stale internal row survives settlement", async () => {
    // The ledger is the only long-lived structure, and `items()` projects it
    // one-to-one — so a leaked internal row would necessarily show up as an
    // extra public item. Churn a batch of operations and assert the projection
    // is exactly the confirmed set.
    const list = optimisticList<number>([]);
    for (let i = 0; i < 25; i++) {
      const d = gate<number>();
      const p = list.add(i, () => d.promise);
      if (i % 2 === 0) d.resolve(i * 100);
      else d.reject(new Error(`fail ${i}`));
      await p;
    }
    expect(list.items()).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400]);
    expect(list.pending()).toBe(false);

    // Removing everything must leave nothing behind at all.
    const r = gate<void>();
    const pr = list.remove(
      () => true,
      () => r.promise,
    );
    r.resolve();
    await pr;
    expect(list.items()).toEqual([]);
  });

  it("15. a non-Error rejection still settles the operation completely", async () => {
    const list = optimisticList<number>([1]);
    const a = gate<number>();
    const p = list.add(2, () => a.promise);

    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    a.reject("a bare string, not an Error");
    await p;

    expect(list.items()).toEqual([1]);
    expect(list.pending()).toBe(false);
  });

  it("a throwing predicate propagates and does NOT leak the pending count", async () => {
    // Found in self-review: allocating the inflight slot before running the
    // user's predicate meant a throwing predicate escaped past every `finally`,
    // leaving `pending()` stuck true for the lifetime of the list. The
    // synchronous optimistic phase now completes before the slot is taken.
    const list = optimisticList<number>([1, 2, 3]);
    const boom = new Error("predicate exploded");

    await expect(
      list.remove(
        () => {
          throw boom;
        },
        async () => {},
      ),
    ).rejects.toBe(boom);
    expect(list.pending(), "a throwing predicate leaked the pending count").toBe(false);
    expect(list.items()).toEqual([1, 2, 3]);

    // `update` too — its patch phase runs the predicate as well. Uses an object
    // list because `Partial<number>` is not a meaningful patch type.
    const objects = optimisticList<Todo>([{ id: 1, text: "a" }]);
    await expect(
      objects.update(
        () => {
          throw boom;
        },
        { text: "z" },
        async () => ({ id: 1, text: "z" }),
      ),
    ).rejects.toBe(boom);
    expect(objects.pending()).toBe(false);
    expect(objects.items()).toEqual([{ id: 1, text: "a" }]);

    // …and the list still works afterwards.
    const d = gate<number>();
    const p = list.add(4, () => d.promise);
    expect(list.pending()).toBe(true);
    d.resolve(40);
    await p;
    expect(list.items()).toEqual([1, 2, 3, 40]);
    expect(list.pending()).toBe(false);
  });

  it("15b. every failure path is awaited without producing an unhandled rejection", async () => {
    // `add`/`remove`/`update` contain their own failures and resolve rather than
    // reject, so the caller never has to attach a handler.
    const list = optimisticList<Todo>([{ id: 1, text: "a" }]);
    const results = await Promise.all([
      list.add({ id: 2, text: "b" }, () => Promise.reject(new Error("add"))),
      list.remove(
        (t) => t.id === 1,
        () => Promise.reject(new Error("remove")),
      ),
      list.update(
        (t) => t.id === 1,
        { text: "z" },
        () => Promise.reject(new Error("update")),
      ),
    ]);
    expect(results).toEqual([undefined, undefined, undefined]);
    await tick();
    expect(list.items()).toEqual([{ id: 1, text: "a" }]);
    expect(list.pending()).toBe(false);
  });
});
