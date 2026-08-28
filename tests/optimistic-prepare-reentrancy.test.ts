/**
 * `optimisticList()` — reentrancy during PREPARE, and the per-row claim chain.
 *
 * WHAT WAS WRONG
 * --------------
 * `update()` allocated its operation id before PREPARE, then ran user code:
 *
 *     const opId = ++nextOpId;          // ← order established here
 *     predicate(row.value);             // ← user code, may re-enter
 *     { ...row.value, ...patch };       // ← patch getters, may re-enter
 *
 * A nested `update()` started from either of those receives a HIGHER id and
 * commits immediately. When the outer operation's COMMIT finally ran it did:
 *
 *     p.row.owner = opId;               // unconditional
 *
 * so the older operation took ownership back from an operation that started
 * after it. A single `owner` field cannot express this: it records who owns the
 * row *now*, not the order in which operations claimed it, and there is nowhere
 * to keep the older claim while a newer one sits on top of it.
 *
 * THE MODEL UNDER TEST
 * --------------------
 * Each row carries a `base` — its last confirmed value — plus a stack of claims
 * ordered by operation id. `items()` shows the TOP claim, or `base` when there
 * are none. An operation inserts its claim at its own ordered position, so a
 * claim from a nested operation sits above the outer one no matter which
 * commits first.
 *
 * On settlement a claim either resolves in place (success) or vanishes
 * (failure); settled claims are then folded into `base` from the bottom up, so
 * a failing claim always reveals exactly whatever is beneath it — the older
 * operation's optimistic value if it is still pending, its confirmed value if
 * it already succeeded, or the original value if it failed too.
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

const seed = (): Item[] => [{ id: 1, value: "initial" }];

// ─── the two mandated reproductions ─────────────────────────────────────────

describe("an update started during PREPARE outranks the operation that triggered it", () => {
  it("A. reentrant update from the PREDICATE", async () => {
    const list = optimisticList<Item>(seed());
    const olderGate = gate<Item>();
    const newerGate = gate<Item>();
    let newer: Promise<void> | undefined;
    let fired = false;

    const older = list.update(
      (item) => {
        if (!fired) {
          fired = true;
          newer = list.update(
            (candidate) => candidate.id === item.id,
            { value: "newer optimistic" },
            () => newerGate.promise,
          );
        }
        return item.id === 1;
      },
      { value: "older optimistic" },
      () => olderGate.promise,
    );

    // The nested claim is on top even though the outer operation committed last.
    expect(list.items()).toEqual([{ id: 1, value: "newer optimistic" }]);

    newerGate.resolve({ id: 1, value: "newer confirmed" });
    await newer;
    olderGate.resolve({ id: 1, value: "older confirmed" });
    await older;

    expect(list.items()).toEqual([{ id: 1, value: "newer confirmed" }]);
    expect(list.pending()).toBe(false);
  });

  it("B. reentrant update from the PATCH GETTER", async () => {
    const list = optimisticList<Item>(seed());
    const olderGate = gate<Item>();
    const newerGate = gate<Item>();
    let newer: Promise<void> | undefined;
    let fired = false;

    const patch = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        if (!fired) {
          fired = true;
          newer = list.update(
            (item) => item.id === 1,
            { value: "newer optimistic" },
            () => newerGate.promise,
          );
        }
        return "older optimistic";
      },
    }) as Partial<Item>;

    const older = list.update(
      (item) => item.id === 1,
      patch,
      () => olderGate.promise,
    );

    expect(list.items()).toEqual([{ id: 1, value: "newer optimistic" }]);

    newerGate.resolve({ id: 1, value: "newer confirmed" });
    await newer;
    olderGate.resolve({ id: 1, value: "older confirmed" });
    await older;

    expect(list.items()).toEqual([{ id: 1, value: "newer confirmed" }]);
    expect(list.pending()).toBe(false);
  });
});

// ─── the complete settlement matrix ─────────────────────────────────────────

type Trigger = "predicate" | "getter";
type Outcome = "ok" | "fail";

interface Scenario {
  list: ReturnType<typeof optimisticList<Item>>;
  olderGate: Deferred<Item>;
  newerGate: Deferred<Item>;
  older: Promise<void>;
  newer: Promise<void>;
}

/** Start an outer update whose PREPARE launches a nested update on the same row. */
function scenario(trigger: Trigger): Scenario {
  const list = optimisticList<Item>(seed());
  const olderGate = gate<Item>();
  const newerGate = gate<Item>();
  let newer: Promise<void> | undefined;
  let fired = false;

  const startNewer = () => {
    if (fired) return;
    fired = true;
    newer = list.update(
      (item) => item.id === 1,
      { value: "newer optimistic" },
      () => newerGate.promise,
    );
  };

  let older: Promise<void>;
  if (trigger === "predicate") {
    older = list.update(
      (item) => {
        startNewer();
        return item.id === 1;
      },
      { value: "older optimistic" },
      () => olderGate.promise,
    );
  } else {
    const patch = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        startNewer();
        return "older optimistic";
      },
    }) as Partial<Item>;
    older = list.update(
      (item) => item.id === 1,
      patch,
      () => olderGate.promise,
    );
  }

  return { list, olderGate, newerGate, older, newer: newer as Promise<void> };
}

const settleOlder = (s: Scenario, o: Outcome) =>
  o === "ok" ? s.olderGate.resolve({ id: 1, value: "older confirmed" }) : s.olderGate.reject(new Error("older failed"));
const settleNewer = (s: Scenario, o: Outcome) =>
  o === "ok" ? s.newerGate.resolve({ id: 1, value: "newer confirmed" }) : s.newerGate.reject(new Error("newer failed"));

/** The final value required by the specification, for every combination. */
const FINAL: Record<Outcome, Record<Outcome, string>> = {
  ok: { ok: "newer confirmed", fail: "older confirmed" },
  fail: { ok: "newer confirmed", fail: "initial" },
};

for (const trigger of ["predicate", "getter"] as const) {
  describe(`settlement matrix — reentrancy from the ${trigger}`, () => {
    for (const older of ["ok", "fail"] as const) {
      for (const newer of ["ok", "fail"] as const) {
        for (const first of ["older", "newer"] as const) {
          it(`older ${older} / newer ${newer}, ${first} settles first`, async () => {
            const s = scenario(trigger);

            // While both are pending the NEWER optimistic value is on top.
            expect(s.list.items()).toEqual([{ id: 1, value: "newer optimistic" }]);
            expect(s.list.pending()).toBe(true);

            if (first === "older") {
              settleOlder(s, older);
              await s.older;
              expect(s.list.pending(), "pending dropped while the newer op was in flight").toBe(true);
              // The newer claim is still on top, so nothing visible changed yet.
              expect(s.list.items()).toEqual([{ id: 1, value: "newer optimistic" }]);

              settleNewer(s, newer);
              await s.newer;
            } else {
              settleNewer(s, newer);
              await s.newer;
              expect(s.list.pending(), "pending dropped while the older op was in flight").toBe(true);
              // A newer FAILURE must reveal the older operation's optimistic
              // value, because that operation is still running.
              expect(s.list.items()).toEqual([
                { id: 1, value: newer === "ok" ? "newer confirmed" : "older optimistic" },
              ]);

              settleOlder(s, older);
              await s.older;
            }

            expect(s.list.items(), "final state").toEqual([{ id: 1, value: FINAL[older][newer] }]);
            expect(s.list.pending()).toBe(false);
            expect(s.list.items()).toHaveLength(1);
          });
        }
      }
    }
  });
}

// ─── three-level nesting ────────────────────────────────────────────────────

describe("three updates started during one PREPARE chain", () => {
  interface Chain {
    list: ReturnType<typeof optimisticList<Item>>;
    a: Deferred<Item>;
    b: Deferred<Item>;
    c: Deferred<Item>;
    pa: Promise<void>;
    pb: Promise<void>;
    pc: Promise<void>;
  }

  /** A's PREPARE starts B; B's PREPARE starts C. */
  function chain(): Chain {
    const list = optimisticList<Item>(seed());
    const a = gate<Item>();
    const b = gate<Item>();
    const c = gate<Item>();
    let pb: Promise<void> | undefined;
    let pc: Promise<void> | undefined;
    let firedB = false;
    let firedC = false;

    const pa = list.update(
      (item) => {
        if (!firedB) {
          firedB = true;
          pb = list.update(
            (inner) => {
              if (!firedC) {
                firedC = true;
                pc = list.update(
                  (deepest) => deepest.id === 1,
                  { value: "C optimistic" },
                  () => c.promise,
                );
              }
              return inner.id === 1;
            },
            { value: "B optimistic" },
            () => b.promise,
          );
        }
        return item.id === 1;
      },
      { value: "A optimistic" },
      () => a.promise,
    );

    return { list, a, b, c, pa, pb: pb as Promise<void>, pc: pc as Promise<void> };
  }

  it("the deepest operation is the visible claim", () => {
    const k = chain();
    expect(k.list.items()).toEqual([{ id: 1, value: "C optimistic" }]);
    // Settle everything so the test leaves nothing pending.
    k.a.reject(new Error("a"));
    k.b.reject(new Error("b"));
    k.c.reject(new Error("c"));
    return Promise.all([k.pa, k.pb, k.pc]);
  });

  it("failures unwind C → B → A → original", async () => {
    const k = chain();
    expect(k.list.items()).toEqual([{ id: 1, value: "C optimistic" }]);

    k.c.reject(new Error("C failed"));
    await k.pc;
    expect(k.list.items()).toEqual([{ id: 1, value: "B optimistic" }]);
    expect(k.list.pending()).toBe(true);

    k.b.reject(new Error("B failed"));
    await k.pb;
    expect(k.list.items()).toEqual([{ id: 1, value: "A optimistic" }]);
    expect(k.list.pending()).toBe(true);

    k.a.reject(new Error("A failed"));
    await k.pa;
    expect(k.list.items()).toEqual([{ id: 1, value: "initial" }]);
    expect(k.list.pending()).toBe(false);
  });

  it("a confirmed value beneath a newer claim becomes the fallback", async () => {
    const k = chain();

    // B succeeds while C is still on top — nothing visible changes yet.
    k.b.resolve({ id: 1, value: "B confirmed" });
    await k.pb;
    expect(k.list.items()).toEqual([{ id: 1, value: "C optimistic" }]);

    // C fails, revealing B's CONFIRMED value rather than its optimistic one.
    k.c.reject(new Error("C failed"));
    await k.pc;
    expect(k.list.items()).toEqual([{ id: 1, value: "B confirmed" }]);

    k.a.reject(new Error("A failed"));
    await k.pa;
    // A's failure cannot undo B's confirmed result.
    expect(k.list.items()).toEqual([{ id: 1, value: "B confirmed" }]);
    expect(k.list.pending()).toBe(false);
  });

  it("the deepest success wins over every older settlement, in any order", async () => {
    const k = chain();

    k.a.resolve({ id: 1, value: "A confirmed" });
    await k.pa;
    k.c.resolve({ id: 1, value: "C confirmed" });
    await k.pc;
    k.b.resolve({ id: 1, value: "B confirmed" });
    await k.pb;

    expect(k.list.items()).toEqual([{ id: 1, value: "C confirmed" }]);
    expect(k.list.pending()).toBe(false);
  });

  it("an older confirmed value survives a newer failure two levels up", async () => {
    const k = chain();

    k.a.resolve({ id: 1, value: "A confirmed" });
    await k.pa;
    k.b.reject(new Error("B failed"));
    await k.pb;
    // C is still on top.
    expect(k.list.items()).toEqual([{ id: 1, value: "C optimistic" }]);

    k.c.reject(new Error("C failed"));
    await k.pc;
    expect(k.list.items()).toEqual([{ id: 1, value: "A confirmed" }]);
    expect(k.list.pending()).toBe(false);
  });
});

// ─── PREPARE reentrancy with the other operations ───────────────────────────

describe("PREPARE reentrancy with add and remove", () => {
  it("a predicate that starts an add()", async () => {
    const list = optimisticList<Item>(seed());
    const g = gate<Item>();
    const addGate = gate<Item>();
    let adding: Promise<void> | undefined;
    let fired = false;

    const updating = list.update(
      (item) => {
        if (!fired) {
          fired = true;
          adding = list.add({ id: 2, value: "added" }, () => addGate.promise);
        }
        return item.id === 1;
      },
      { value: "patched" },
      () => g.promise,
    );

    expect(list.items()).toEqual([
      { id: 1, value: "patched" },
      { id: 2, value: "added" },
    ]);

    addGate.resolve({ id: 2, value: "added confirmed" });
    await adding;
    g.resolve({ id: 1, value: "patched confirmed" });
    await updating;

    expect(list.items()).toEqual([
      { id: 1, value: "patched confirmed" },
      { id: 2, value: "added confirmed" },
    ]);
    expect(list.pending()).toBe(false);
  });

  it("a patch getter that starts an add()", async () => {
    const list = optimisticList<Item>(seed());
    const g = gate<Item>();
    let adding: Promise<void> | undefined;
    let fired = false;

    const patch = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        if (!fired) {
          fired = true;
          adding = list.add({ id: 2, value: "added" }, async () => ({ id: 2, value: "added confirmed" }));
        }
        return "patched";
      },
    }) as Partial<Item>;

    const updating = list.update(
      (item) => item.id === 1,
      patch,
      () => g.promise,
    );
    await adding;
    g.resolve({ id: 1, value: "patched confirmed" });
    await updating;

    expect(list.items()).toEqual([
      { id: 1, value: "patched confirmed" },
      { id: 2, value: "added confirmed" },
    ]);
    expect(list.pending()).toBe(false);
  });

  it("a predicate that starts a remove() of the row being prepared", async () => {
    const list = optimisticList<Item>(seed());
    const g = gate<Item>();
    const removeGate = gate<void>();
    let removing: Promise<void> | undefined;
    let fired = false;

    const updating = list.update(
      (item) => {
        if (!fired) {
          fired = true;
          removing = list.remove(
            (candidate) => candidate.id === 1,
            () => removeGate.promise,
          );
        }
        return item.id === 1;
      },
      { value: "patched" },
      () => g.promise,
    );

    // The row is hidden by the nested remove, so nothing is visible…
    expect(list.items()).toEqual([]);

    g.resolve({ id: 1, value: "patched confirmed" });
    await updating;
    removeGate.reject(new Error("remove failed"));
    await removing;

    // …and when the removal fails the row returns carrying the value the outer
    // update confirmed while it was off screen.
    expect(list.items()).toEqual([{ id: 1, value: "patched confirmed" }]);
    expect(list.pending()).toBe(false);
  });

  it("a patch getter that starts a remove(), and the removal succeeds", async () => {
    const list = optimisticList<Item>(seed());
    const g = gate<Item>();
    let removing: Promise<void> | undefined;
    let fired = false;

    const patch = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        if (!fired) {
          fired = true;
          removing = list.remove(
            (item) => item.id === 1,
            async () => {},
          );
        }
        return "patched";
      },
    }) as Partial<Item>;

    const updating = list.update(
      (item) => item.id === 1,
      patch,
      () => g.promise,
    );
    await removing;
    g.resolve({ id: 1, value: "patched confirmed" });
    await updating;

    expect(list.items()).toEqual([]);
    expect(list.pending()).toBe(false);
  });

  it("a disjoint-row reentrant update settles independently", async () => {
    const list = optimisticList<Item>([
      { id: 1, value: "a" },
      { id: 2, value: "b" },
    ]);
    const outerGate = gate<Item>();
    const innerGate = gate<Item>();
    let inner: Promise<void> | undefined;
    let fired = false;

    const outer = list.update(
      (item) => {
        if (!fired) {
          fired = true;
          inner = list.update(
            (other) => other.id === 2,
            { value: "B" },
            () => innerGate.promise,
          );
        }
        return item.id === 1;
      },
      { value: "A" },
      () => outerGate.promise,
    );

    expect(list.items()).toEqual([
      { id: 1, value: "A" },
      { id: 2, value: "B" },
    ]);

    outerGate.reject(new Error("outer failed"));
    await outer;
    expect(list.items()).toEqual([
      { id: 1, value: "a" },
      { id: 2, value: "B" },
    ]);

    innerGate.resolve({ id: 2, value: "B confirmed" });
    await inner;
    expect(list.items()).toEqual([
      { id: 1, value: "a" },
      { id: 2, value: "B confirmed" },
    ]);
    expect(list.pending()).toBe(false);
  });

  it("duplicate primitives keep independent claim chains", async () => {
    const list = optimisticList<number>([7, 7]);
    const outerGate = gate<number>();
    let inner: Promise<void> | undefined;
    let fired = false;

    const outer = list.update(
      (v) => {
        if (!fired) {
          fired = true;
          inner = list.add(7, async () => 77);
        }
        return v === 7;
      },
      {} as Partial<number>,
      () => outerGate.promise,
    );

    await inner;
    outerGate.reject(new Error("outer failed"));
    await outer;

    // Both original rows reverted; the reentrant add landed in its own row.
    expect(list.items()).toEqual([7, 7, 77]);
    expect(list.pending()).toBe(false);
  });

  it("duplicate object references keep independent claim chains", async () => {
    const shared = { id: 1, value: "s" };
    const list = optimisticList<Item>([shared, shared]);
    const outerGate = gate<Item>();
    const innerGate = gate<Item>();
    let inner: Promise<void> | undefined;
    let fired = false;

    const outer = list.update(
      (item) => {
        if (!fired) {
          fired = true;
          inner = list.update(
            (x) => x === shared,
            { value: "inner" },
            () => innerGate.promise,
          );
        }
        return item === shared || item.value === "inner";
      },
      { value: "outer" },
      () => outerGate.promise,
    );

    // Both rows carry the inner claim on top.
    expect(list.items()).toEqual([
      { id: 1, value: "inner" },
      { id: 1, value: "inner" },
    ]);

    innerGate.reject(new Error("inner failed"));
    await inner;
    expect(list.items()).toEqual([
      { id: 1, value: "outer" },
      { id: 1, value: "outer" },
    ]);

    outerGate.resolve({ id: 1, value: "outer confirmed" });
    await outer;
    expect(list.items()).toEqual([
      { id: 1, value: "outer confirmed" },
      { id: 1, value: "outer confirmed" },
    ]);
    expect(list.pending()).toBe(false);
  });

  it("only a LATER matched row triggers the reentrant operation", async () => {
    // The first row is prepared before the nested operation exists; the second
    // triggers it. Both of the outer operation's claims must still sit beneath
    // the nested one.
    const list = optimisticList<Item>([
      { id: 1, value: "a" },
      { id: 2, value: "b" },
    ]);
    const outerGate = gate<Item>();
    const innerGate = gate<Item>();
    let inner: Promise<void> | undefined;

    const outer = list.update(
      (item) => {
        if (item.id === 2 && !inner) {
          inner = list.update(
            (x) => x.id === 1,
            { value: "inner" },
            () => innerGate.promise,
          );
        }
        return true;
      },
      { value: "outer" },
      () => outerGate.promise,
    );

    expect(list.items()).toEqual([
      { id: 1, value: "inner" },
      { id: 2, value: "outer" },
    ]);

    innerGate.reject(new Error("inner failed"));
    await inner;
    expect(list.items()).toEqual([
      { id: 1, value: "outer" },
      { id: 2, value: "outer" },
    ]);

    outerGate.resolve({ id: 0, value: "outer confirmed" });
    await outer;
    expect(list.items()).toEqual([
      { id: 0, value: "outer confirmed" },
      { id: 0, value: "outer confirmed" },
    ]);
    expect(list.pending()).toBe(false);
  });

  it("a synchronously settling nested operation is still ordered above", async () => {
    const list = optimisticList<Item>(seed());
    const outerGate = gate<Item>();
    let inner: Promise<void> | undefined;
    let fired = false;

    const outer = list.update(
      (item) => {
        if (!fired) {
          fired = true;
          inner = list.update(
            (x) => x.id === 1,
            { value: "inner" },
            async () => ({ id: 1, value: "inner confirmed" }),
          );
        }
        return item.id === 1;
      },
      { value: "outer" },
      () => outerGate.promise,
    );

    await inner;
    expect(list.items()).toEqual([{ id: 1, value: "inner confirmed" }]);

    outerGate.resolve({ id: 1, value: "outer confirmed" });
    await outer;
    // The older confirmed value must not surface over the newer confirmed one.
    expect(list.items()).toEqual([{ id: 1, value: "inner confirmed" }]);
    expect(list.pending()).toBe(false);
  });

  it("a nested operation given an already-rejected promise settles cleanly", async () => {
    const list = optimisticList<Item>(seed());
    const outerGate = gate<Item>();
    let inner: Promise<void> | undefined;
    let fired = false;

    const outer = list.update(
      (item) => {
        if (!fired) {
          fired = true;
          inner = list.update(
            (x) => x.id === 1,
            { value: "inner" },
            () => Promise.reject(new Error("already rejected")),
          );
        }
        return item.id === 1;
      },
      { value: "outer" },
      () => outerGate.promise,
    );

    await inner;
    expect(list.items()).toEqual([{ id: 1, value: "outer" }]);

    outerGate.resolve({ id: 1, value: "outer confirmed" });
    await outer;
    expect(list.items()).toEqual([{ id: 1, value: "outer confirmed" }]);
    expect(list.pending()).toBe(false);
  });
});

// ─── exception safety in PREPARE ────────────────────────────────────────────

describe("a PREPARE that throws after starting a nested operation", () => {
  it("predicate throws: the outer leaves nothing, the nested survives", async () => {
    const list = optimisticList<Item>(seed());
    const innerGate = gate<Item>();
    let inner: Promise<void> | undefined;
    let fired = false;
    const boom = new Error("predicate failed");

    await expect(
      list.update(
        () => {
          if (!fired) {
            fired = true;
            inner = list.update(
              (x) => x.id === 1,
              { value: "inner" },
              () => innerGate.promise,
            );
          }
          throw boom;
        },
        { value: "outer" },
        async () => ({ id: 1, value: "never" }),
      ),
    ).rejects.toBe(boom);

    // Only the nested operation is in flight, and only its claim exists.
    expect(list.items()).toEqual([{ id: 1, value: "inner" }]);
    expect(list.pending()).toBe(true);

    innerGate.resolve({ id: 1, value: "inner confirmed" });
    await inner;
    expect(list.items()).toEqual([{ id: 1, value: "inner confirmed" }]);
    expect(list.pending()).toBe(false);
  });

  it("patch getter throws: the outer leaves nothing, the nested survives", async () => {
    const list = optimisticList<Item>(seed());
    const innerGate = gate<Item>();
    let inner: Promise<void> | undefined;
    let fired = false;
    const boom = new Error("getter failed");

    const patch = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        if (!fired) {
          fired = true;
          inner = list.update(
            (x) => x.id === 1,
            { value: "inner" },
            () => innerGate.promise,
          );
        }
        throw boom;
      },
    }) as Partial<Item>;

    await expect(
      list.update(
        (item) => item.id === 1,
        patch,
        async () => ({ id: 1, value: "never" }),
      ),
    ).rejects.toBe(boom);

    expect(list.items()).toEqual([{ id: 1, value: "inner" }]);
    expect(list.pending()).toBe(true);

    innerGate.reject(new Error("inner failed"));
    await inner;
    expect(list.items()).toEqual([{ id: 1, value: "initial" }]);
    expect(list.pending()).toBe(false);
  });

  it("a getter throwing on the SECOND row leaves the first row untouched too", async () => {
    const list = optimisticList<Item>([
      { id: 1, value: "one" },
      { id: 2, value: "two" },
    ]);
    let reads = 0;
    let inner: Promise<void> | undefined;

    const patch = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        reads++;
        if (reads === 1) {
          inner = list.update(
            (x) => x.id === 2,
            { value: "inner" },
            async () => ({ id: 2, value: "inner confirmed" }),
          );
          return "patched";
        }
        throw new Error("second read failed");
      },
    }) as Partial<Item>;

    await expect(
      list.update(
        () => true,
        patch,
        async () => ({ id: 0, value: "never" }),
      ),
    ).rejects.toThrow("second read failed");
    await inner;

    // The outer operation staked nothing at all; the nested one landed normally.
    expect(list.items()).toEqual([
      { id: 1, value: "one" },
      { id: 2, value: "inner confirmed" },
    ]);
    expect(list.pending()).toBe(false);
  });

  it("no unhandled rejection escapes any PREPARE-reentrancy path", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const trigger of ["predicate", "getter"] as const) {
        for (const older of ["ok", "fail"] as const) {
          for (const newer of ["ok", "fail"] as const) {
            const s = scenario(trigger);
            settleNewer(s, newer);
            await s.newer;
            settleOlder(s, older);
            await s.older;
            expect(s.list.pending()).toBe(false);
          }
        }
      }
      await tick();
      await tick();
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// ─── claim bookkeeping is bounded ───────────────────────────────────────────

describe("claim bookkeeping", () => {
  it("does not accumulate across many nested operations", async () => {
    // A leaked claim would keep publishing a stale value, so driving hundreds of
    // nested pairs and asserting the exact final projection is what catches one.
    const list = optimisticList<Item>(seed());

    for (let i = 0; i < 200; i++) {
      const s = scenario("predicate");
      if (i % 2 === 0) {
        settleNewer(s, "ok");
        await s.newer;
        settleOlder(s, "fail");
        await s.older;
        expect(s.list.items()).toEqual([{ id: 1, value: "newer confirmed" }]);
      } else {
        settleOlder(s, "ok");
        await s.older;
        settleNewer(s, "fail");
        await s.newer;
        expect(s.list.items()).toEqual([{ id: 1, value: "older confirmed" }]);
      }
      expect(s.list.pending()).toBe(false);
    }

    // The shared list is untouched, and a fresh operation still behaves exactly.
    const g = gate<Item>();
    const p = list.update(
      (i) => i.id === 1,
      { value: "final" },
      () => g.promise,
    );
    expect(list.items()).toEqual([{ id: 1, value: "final" }]);
    g.resolve({ id: 1, value: "final confirmed" });
    await p;
    expect(list.items()).toEqual([{ id: 1, value: "final confirmed" }]);
    expect(list.pending()).toBe(false);
  });

  it("an older settlement never republishes over a newer active claim", async () => {
    // The claim beneath resolves in place. `items` must not change while a newer
    // claim is still on top, so a subscriber sees no spurious re-render — and,
    // more importantly, never briefly sees the older value.
    const s = scenario("predicate");
    const seen: string[][] = [];
    const stop = effect(() => {
      seen.push(s.list.items().map((i) => i.value));
    });

    settleOlder(s, "ok");
    await s.older;
    // No new observation: the newer claim is still on top.
    expect(seen).toEqual([["newer optimistic"]]);

    settleNewer(s, "ok");
    await s.newer;
    expect(seen).toEqual([["newer optimistic"], ["newer confirmed"]]);
    stop();
    expect(s.list.pending()).toBe(false);
  });

  it("leaves no claim behind once every operation has settled", async () => {
    // Claims are private, but they are the only thing that can make a row read
    // back as anything other than its base. Driving each settlement order and
    // then re-reading the row through a fresh, uncontested update proves the
    // stack collapsed: a leftover claim would shadow the new one or publish a
    // stale value.
    for (const trigger of ["predicate", "getter"] as const) {
      for (const older of ["ok", "fail"] as const) {
        for (const newer of ["ok", "fail"] as const) {
          for (const first of ["older", "newer"] as const) {
            const s = scenario(trigger);
            if (first === "older") {
              settleOlder(s, older);
              await s.older;
              settleNewer(s, newer);
              await s.newer;
            } else {
              settleNewer(s, newer);
              await s.newer;
              settleOlder(s, older);
              await s.older;
            }
            expect(s.list.pending()).toBe(false);

            const g = gate<Item>();
            const p = s.list.update(
              () => true,
              { value: "after" },
              () => g.promise,
            );
            // The fresh claim is on top of nothing but the settled base.
            expect(s.list.items()).toEqual([{ id: 1, value: "after" }]);
            g.reject(new Error("discarded"));
            await p;
            // Dropping it reveals the base, which must be the settled outcome —
            // not an optimistic value some earlier claim never cleaned up.
            expect(s.list.items()).toEqual([{ id: 1, value: FINAL[older][newer] }]);
            expect(s.list.pending()).toBe(false);
          }
        }
      }
    }
  });

  it("repeated overlapping claims on one row settle to the newest every time", async () => {
    const list = optimisticList<Item>(seed());
    for (let round = 0; round < 50; round++) {
      const s = scenario("getter");
      settleOlder(s, "ok");
      await s.older;
      settleNewer(s, "ok");
      await s.newer;
      expect(s.list.items()).toEqual([{ id: 1, value: "newer confirmed" }]);
      expect(s.list.pending()).toBe(false);
    }
    expect(list.items()).toEqual([{ id: 1, value: "initial" }]);
  });
});
