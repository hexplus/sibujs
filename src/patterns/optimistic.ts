import { signal } from "../core/signals/signal";
import { batch } from "../reactivity/batch";

// ============================================================================
// OPTIMISTIC UPDATES
// ============================================================================

/**
 * optimistic provides optimistic UI updates that can be reverted on failure.
 * The value updates immediately, then reverts if the async operation fails.
 *
 * Returns a named object with `value`, `pending`, and `update`.
 *
 * CONCURRENCY MODEL — last writer wins, deliberately.
 *
 * A scalar has exactly one logical row, so "which operation owns the value" and
 * "which operation started last" are the same question. Each operation is tagged
 * with a version counter and only settles the value if no newer operation has
 * started since. That is a coherent model here precisely because there is
 * nothing to be disjoint with.
 *
 * `optimisticList` deliberately does NOT share this design: an array has many
 * independent rows, so a global version counter cannot tell "a newer operation
 * changed the row I am about to revert" from "a newer operation changed a
 * completely different row". See the note above `optimisticList`.
 *
 * @example
 * ```ts
 * const likes = optimistic(42);
 *
 * button(
 *   { on: { click: () => likes.update(likes.value() + 1, () => api.like()) } },
 *   () => `${likes.value()} ${likes.pending() ? "(saving…)" : ""}`,
 * );
 * ```
 */
export function optimistic<T>(initialValue: T): {
  value: () => T;
  pending: () => boolean;
  update: (optimisticValue: T, asyncAction: () => Promise<T>) => Promise<void>;
} {
  const [value, setValue] = signal<T>(initialValue);
  const [pending, setPending] = signal(false);
  let inflightCount = 0;
  let version = 0;

  async function update(optimisticValue: T, asyncAction: () => Promise<T>): Promise<void> {
    const myVersion = ++version;
    const previousValue = value();
    setValue(optimisticValue);
    inflightCount++;
    setPending(true);

    try {
      const result = await asyncAction();
      if (version === myVersion) {
        setValue(result);
      }
    } catch {
      if (version === myVersion) {
        setValue(previousValue);
      }
    } finally {
      inflightCount--;
      if (inflightCount <= 0) {
        inflightCount = 0;
        setPending(false);
      }
    }
  }

  return { value, pending, update };
}

// ============================================================================
// OPTIMISTIC LIST
// ============================================================================
//
// WHY A ROW LEDGER RATHER THAN ARRAY SNAPSHOTS
// --------------------------------------------
// The previous implementation captured the whole array before each operation
// and, on failure, either restored that snapshot wholesale or — if any newer
// operation had started — skipped the rollback entirely:
//
//     end(myVersion, () => setItems(prev));   // only when version === myVersion
//
// Both halves are wrong, and they are wrong in opposite directions.
//
// Skipping the rollback leaves the failed operation's optimistic artifact
// visible forever. Given `[1,2,3]`, `add(4)` then `add(5)`, a failure of the
// first add produced `[1,2,3,4,5]`: the item that failed to save is still on
// screen, indefinitely, because a *different* row happened to be saved after it.
//
// Performing the rollback is no better. Restoring `prev` discards every change
// any newer operation made, because a snapshot of the whole array is a claim
// about rows the failing operation never touched.
//
// A global version counter cannot choose correctly between those, because
// "is there a newer operation" is not the relevant question. The relevant
// question is per row: does this operation still own what it is about to change?
//
// So the list is stored as a ledger of tracked rows. Each row carries a stable
// id, its last CONFIRMED value, and an ordered chain of claims — one per
// operation that has touched it, positioned by invocation order. An operation
// records only the rows it touched and, on settlement, resolves or drops its own
// claim and nothing else. Disjoint operations therefore never interact, and an
// operation can only ever undo its own mutation.
//
// (An earlier version stored a single `owner` field — the id of whichever
// operation had written the row last. That records who owns the row *now*, not
// the order in which operations claimed it, and leaves nowhere to keep an older
// claim while a newer one sits above it. See "OWNERSHIP IS A CLAIM CHAIN" below.)
//
// `items()` projects the effective value out of the ledger, so no id, claim or
// wrapper is observable through the public API.

//
// WHY THE REGISTRY OUTLIVES VISIBILITY
// ------------------------------------
// The first version of this ledger stored only the rows currently on screen, so
// a `remove()` in flight took its rows *out of the ledger* and carried copies of
// them in its own rollback list. That splits one logical row into two
// representations, and an operation that owned the row's value could no longer
// find it:
//
//     add(2) pending · remove(2) pending · add resolves with 20 · remove fails
//       →  [1, 2]        the confirmed server value was written nowhere
//
//     update(→"optimistic") pending · remove pending · update FAILS · remove fails
//       →  [{ value: "optimistic" }]   a failed update's patch, resurrected
//
// In both cases the settling operation found no row, did nothing, and the failed
// remove then reinstated the copy it had captured — a snapshot from before the
// settlement.
//
// So visibility and identity are now separate. `records` holds the authoritative
// row for as long as any operation might settle against it, whether or not the
// row is on screen; `visible` is just the ordered list of ids currently shown.
// A settling `add`/`update` addresses the record, so it lands even while the row
// is hidden, and a failed `remove` makes the row visible again without carrying
// any value of its own.
//
// WHY ROWS CARRY AN ORDERING KEY
// ------------------------------
// Restoring a row at its old ABSOLUTE index is wrong as soon as anything before
// it has changed. Given ["A","B","C","D"], removing B and D and then
// successfully removing A left the rollback inserting B at index 1 of ["C"]:
//
//     ["C", "B", "D"]        B jumped behind C
//
// Each row therefore carries a monotonic ordering key, and `visible` is always
// sorted by it. Restoration is an ordered insert by key, so a row returns to its
// place relative to the rows that are actually still there — no historical array
// and no absolute positions.

//
// PREPARE → COMMIT → PUBLISH
// --------------------------
// Setting `pending` notifies subscribers SYNCHRONOUSLY, and a subscriber may
// call straight back into this list. An earlier version published in the middle
// of its own mutation, so the operation that woke the subscriber was only half
// applied when the subscriber's operation ran — and then finished applying a
// plan computed before the subscriber existed:
//
//     remove computes `kept` · begin() · effect wakes and add()s a row
//       · remove resumes and assigns `visible = kept`   → the new row is erased
//
//     older update claims a row · begin() · effect wakes and update()s the same
//       row · older update resumes and assigns its own owner
//         → the older operation steals ownership back from the newer one
//
// Preparation is also where user code can throw. `{ ...row.value, ...patch }`
// executes the patch's property getters, and doing that after the inflight slot
// was taken leaked `pending()` as true forever.
//
// So every operation runs in three strictly ordered phases:
//
//   PREPARE  runs all user-controlled work — predicates, patch getters — and
//            computes the complete mutation. It touches no framework state, so
//            a throw here leaves the list exactly as it was.
//   COMMIT   applies visibility, ownership and values. No user code runs here,
//            and structural changes are recomputed from the LIVE list rather
//            than a snapshot, so even a reentrant predicate cannot be undone.
//   PUBLISH  writes `pending` and `items` inside one `batch`, so they are
//            observed together and only once the operation is fully committed.
//
// By the time any subscriber runs, the outer operation has no work left to do
// but await its own promise.
//
// COMPLEXITY
// ----------
// Membership is a boolean on the row, not a scan of the visible array. The
// previous `visible.includes(id)` inside loops over matched rows made broad
// operations quadratic — a 20,000-row failed remove took 8.3 seconds. Rows are
// restored by merging two already-sorted runs rather than splicing one at a
// time. For `n` visible rows and `k` affected rows: membership O(1), reference
// release O(k), broad update O(n + k), bulk restoration O(n + k), publication
// O(n).

//
// OWNERSHIP IS A CLAIM CHAIN, NOT A SINGLE OWNER
// ----------------------------------------------
// A row used to record one `owner` — the id of whichever operation had written
// it last. That records who owns the row *now*, not the order in which
// operations claimed it, and it leaves nowhere to keep an older claim while a
// newer one sits on top. Both gaps are reachable, because `update()` allocates
// its id before PREPARE and PREPARE runs user code:
//
//     const opId = ++nextOpId;        // order established here
//     predicate(row.value);           // user code — may re-enter
//     { ...row.value, ...patch };     // patch getters — may re-enter
//
// A nested `update()` started from either gets a HIGHER id and commits first;
// the outer operation's COMMIT then ran `row.owner = opId` unconditionally and
// took the row back from an operation that started after it.
//
// So each row keeps its last confirmed value (`base`) plus a stack of claims
// ordered by operation id. `items()` shows the TOP claim, or `base` when there
// are none, and an operation inserts its claim at its own ordered position —
// which puts a nested operation's claim above its parent's regardless of commit
// order. On settlement a claim either resolves in place (success) or vanishes
// (failure), and settled claims are folded into `base` from the bottom up. A
// failing claim therefore reveals exactly what is beneath it: the older
// operation's optimistic value while it is still pending, its confirmed value
// once it has succeeded, or the original value if it failed too.
//
// Claims live only while their operation does. At idle every row has none, so
// no per-row history accumulates.

/** One operation's claim on one row's value. */
interface Claim<T> {
  /** Invocation order. Strictly increasing, and fixes this claim's position. */
  readonly opId: number;
  /** Optimistic while pending; the confirmed value once `settled`. */
  value: T;
  /**
   * Has the owning operation finished successfully?
   *
   * A settled claim is not removed immediately: an older claim may still be
   * pending beneath it, and collapsing out of order would publish the older
   * value over the newer one. It is folded into `base` as soon as it reaches
   * the bottom of the stack, where nothing can change under it any more.
   */
  settled: boolean;
}

/** One tracked row. Never exposed; `items()` projects the effective value. */
interface Row<T> {
  /** Stable identity, independent of value and of visibility. */
  readonly id: number;
  /**
   * Monotonic ordering token. Allocated once and never reused, so `order`
   * sorted by key is an invariant maintained by construction: `add` appends the
   * largest key, removal preserves relative order, and restoration merges two
   * already-sorted runs.
   */
  readonly key: number;
  /** The value beneath every claim — the last confirmed state of this row. */
  base: T;
  /** Ascending by `opId`. The last entry is what `items()` shows. */
  claims: Claim<T>[];
  /**
   * Is this row currently on screen?
   *
   * Kept in lockstep with `order`, and the ONLY membership test used. Scanning
   * `order` per affected row is what made broad operations quadratic.
   */
  visible: boolean;
  /**
   * How many in-flight operations may still settle against this row.
   *
   * A row that is off screen must survive exactly as long as something can
   * still address it, and no longer. Purging only when the whole list goes idle
   * would be correct but not bounded: a list that always has an operation in
   * flight would accumulate retired rows indefinitely. Counting references
   * retires each row the moment its last holder settles.
   */
  refs: number;
}

/**
 * optimisticList provides optimistic updates for array state.
 *
 * CONCURRENCY MODEL — per-row claim chains ordered by invocation.
 *
 * Every operation gets an id when it is invoked, and every row it touches gets
 * a claim at that id's position in the row's stack. The newest claim is what
 * `items()` shows. On settlement an operation touches only its own claim:
 *
 *   - a failed `add` withdraws exactly the row it inserted, and marks it so a
 *     concurrent failed `remove` cannot reinstate it;
 *   - a successful `add` resolves its own claim; if a later operation has
 *     claimed the row since, that newer claim stays on top;
 *   - a failed `remove` makes its rows visible again, in their correct relative
 *     order and carrying whatever value they hold NOW;
 *   - a successful `remove` retires its rows; each record is dropped as soon as
 *     its last holder settles;
 *   - a failed `update` drops its claim, revealing whatever is beneath it;
 *   - a successful `update` resolves its claim in place, which becomes visible
 *     only once no newer claim sits above it.
 *
 * Operations on disjoint rows are completely independent. Where two operations
 * touch the same row the later one is visible — including when the later one
 * was started by a reactive subscriber, by the outer operation's own predicate,
 * or by one of its patch's property getters.
 *
 * `pending()` is true while any operation is unsettled and becomes false exactly
 * when the last one settles, in any settlement order. It is always published in
 * the same batch as `items()`, so a subscriber never sees one without the other.
 *
 * @example
 * ```ts
 * const todos = optimisticList<Todo>([]);
 *
 * todos.add(
 *   { id: tempId(), text: "New" },
 *   async () => api.createTodo("New"),
 * );
 *
 * div([
 *   () => todos.pending() ? span("Saving…") : null,
 *   each(() => todos.items(), (t) => div(t().text), { key: (t) => t.id }),
 * ]);
 * ```
 */
export function optimisticList<T>(initialValue: T[]): {
  items: () => T[];
  pending: () => boolean;
  add: (item: T, asyncAction: () => Promise<T>) => Promise<void>;
  remove: (predicate: (item: T) => boolean, asyncAction: () => Promise<void>) => Promise<void>;
  update: (predicate: (item: T) => boolean, patch: Partial<T>, asyncAction: () => Promise<T>) => Promise<void>;
} {
  let nextRowId = 0;
  let nextKey = 0;
  let nextOpId = 0;

  /**
   * The authoritative row store, keyed by id.
   *
   * Holds every row an in-flight operation might still settle against — which
   * includes rows a pending `remove` has taken off screen. Row identity lives
   * here and nowhere else: no `WeakMap`, no `Object.is` fallback, so primitives,
   * duplicate primitives and duplicate object references are all individually
   * addressable.
   */
  const records = new Map<number, Row<T>>();

  /** The ids currently on screen, in display order — always sorted by key. */
  let order: number[] = [];

  for (const value of initialValue) {
    const row: Row<T> = { id: nextRowId++, key: nextKey++, base: value, claims: [], visible: true, refs: 0 };
    records.set(row.id, row);
    order.push(row.id);
  }

  /**
   * The effective value of a row: its top claim, or its base.
   *
   * Named `effectiveValue` rather than `valueOf` so it cannot be confused with
   * the `Object.prototype` method of that name.
   */
  function effectiveValue(row: Row<T>): T {
    const claims = row.claims;
    return claims.length > 0 ? claims[claims.length - 1].value : row.base;
  }

  /**
   * The value as an operation invoked at `opId` sees it — ignoring claims made
   * by operations that started later.
   *
   * This is what an outer `update` patches. Reading the *top* claim instead
   * would compute the older operation's optimistic value — and therefore its
   * eventual fallback — from a newer operation's optimistic value, which is a
   * value the older operation never saw and may never have existed on the
   * server. The snapshot an operation prepares from is the list as of its own
   * invocation.
   */
  function valueBelow(row: Row<T>, opId: number): T {
    const claims = row.claims;
    for (let i = claims.length - 1; i >= 0; i--) {
      if (claims[i].opId < opId) return claims[i].value;
    }
    return row.base;
  }

  /**
   * Insert a claim at its ordered position and return it.
   *
   * Ids increase, so a claim normally lands on top and this is O(1). It walks
   * down only when an operation that started EARLIER commits later — exactly the
   * reentrancy case — and then only past the handful of claims that row holds.
   */
  function stake(row: Row<T>, opId: number, value: T): Claim<T> {
    const claim: Claim<T> = { opId, value, settled: false };
    const claims = row.claims;
    let at = claims.length;
    while (at > 0 && claims[at - 1].opId > opId) at--;
    claims.splice(at, 0, claim);
    return claim;
  }

  /** Remove a claim outright — a failed operation leaves nothing behind. */
  function dropClaim(row: Row<T>, claim: Claim<T>): void {
    const at = row.claims.indexOf(claim);
    if (at !== -1) row.claims.splice(at, 1);
  }

  /**
   * Fold settled claims into `base`, bottom up.
   *
   * A settled claim can only be discarded once nothing remains beneath it;
   * until then an older operation might still resolve or fail underneath, and
   * collapsing early would lose its result. Once a settled claim reaches the
   * bottom its value IS the row's confirmed state.
   */
  function collapse(row: Row<T>): void {
    const claims = row.claims;
    let i = 0;
    while (i < claims.length && claims[i].settled) {
      row.base = claims[i].value;
      i++;
    }
    if (i > 0) claims.splice(0, i);
  }

  const [items, setItems] = signal<T[]>(order.map((id) => effectiveValue(records.get(id) as Row<T>)));
  const [pending, setPending] = signal(false);
  let inflight = 0;

  /**
   * Rows that must never be shown again, whatever any rollback decides.
   *
   * A `remove` records the rows it took out so it can reinstate them if the
   * deletion fails, and that rollback must not undo a fact established by a
   * different operation. Two things establish such a fact:
   *
   *   - a creating `add` FAILED, so the row was never persisted. Reinstating it
   *     would put a phantom item on screen.
   *   - a `remove` SUCCEEDED, so the deletion is confirmed. A second remove that
   *     also matched the row — reachable when a predicate re-enters the list and
   *     removes a row the outer predicate is still scanning for — must not bring
   *     it back when it fails.
   *
   * Bounded by construction: an entry is dropped with its row the moment the
   * row's last holder settles, and `settle()` empties the set at idle.
   */
  const retiredRowIds = new Set<number>();

  function project(): T[] {
    const out: T[] = new Array(order.length);
    for (let i = 0; i < order.length; i++) out[i] = effectiveValue(records.get(order[i]) as Row<T>);
    return out;
  }

  /**
   * Apply an internal mutation and publish the result as ONE observable commit.
   *
   * `mutate` runs to completion before any subscriber is notified, because
   * `batch` defers notification until the outermost batch exits. That is what
   * makes the operation fully committed by the time reentrant application code
   * can run, and what stops a subscriber observing `pending` changed while
   * `items` still shows the pre-operation list, or the reverse.
   *
   * `mutate` returns whether the visible projection changed; `items` is only
   * republished when it did, so an operation that touches nothing on screen
   * does not force a re-render.
   *
   * No user-controlled code may run inside `mutate` — that is the whole point.
   */
  function commit(mutate: () => boolean): void {
    batch(() => {
      let visibleChanged = false;
      try {
        visibleChanged = mutate();
      } finally {
        setPending(inflight > 0);
        if (visibleChanged) setItems(project());
      }
    });
  }

  /** Take a row off screen. Keeps `visible` and `order` in lockstep. */
  function hide(id: number): boolean {
    const row = records.get(id);
    if (!row || !row.visible) return false;
    row.visible = false;
    order = order.filter((x) => x !== id);
    return true;
  }

  /**
   * Put eligible rows back on screen, in one pass.
   *
   * `ids` was collected by scanning `order`, which is key-sorted, so the
   * eligible subset is key-sorted too and the result is a merge of two sorted
   * runs — O(n + k). Restoring one row at a time (scan, slice, insert, repeat)
   * is quadratic, which is what made a 20,000-row failed remove take seconds.
   */
  function restore(ids: readonly number[]): boolean {
    const restorable: number[] = [];
    for (const id of ids) {
      const row = records.get(id);
      // Already back (another failed remove reinstated it), retired by a failed
      // `add` or a successful `remove`, or dropped entirely — either way this
      // operation must not insert it.
      if (!row || row.visible || retiredRowIds.has(id)) continue;
      restorable.push(id);
    }
    if (restorable.length === 0) return false;

    const merged: number[] = new Array(order.length + restorable.length);
    let i = 0;
    let j = 0;
    let w = 0;
    while (i < order.length && j < restorable.length) {
      const a = (records.get(order[i]) as Row<T>).key;
      const b = (records.get(restorable[j]) as Row<T>).key;
      merged[w++] = a <= b ? order[i++] : restorable[j++];
    }
    while (i < order.length) merged[w++] = order[i++];
    while (j < restorable.length) merged[w++] = restorable[j++];

    for (const id of restorable) (records.get(id) as Row<T>).visible = true;
    order = merged;
    return true;
  }

  /** Claim the right to settle against these rows later. */
  function retain(ids: readonly number[]): void {
    for (const id of ids) {
      const row = records.get(id);
      if (row) row.refs++;
    }
  }

  /**
   * Give up the claim, retiring any row nothing can reach any more.
   *
   * A row is retired when it is off screen and no in-flight operation holds a
   * reference to it: at that point no settlement can address it and no rollback
   * can reinstate it, so both its record and any revocation for it are dead
   * weight. This is what bounds the two structures under sustained load rather
   * than only at moments of idleness. O(k) — membership is a flag, not a scan.
   */
  function release(ids: readonly number[]): void {
    for (const id of ids) {
      const row = records.get(id);
      if (!row) continue;
      row.refs--;
      if (row.refs <= 0 && !row.visible) {
        records.delete(id);
        retiredRowIds.delete(id);
      }
    }
  }

  /** Release what an operation held and drop its inflight slot. */
  function settle(heldIds: readonly number[]): void {
    release(heldIds);
    inflight--;
    if (inflight <= 0) {
      inflight = 0;
      // Backstop. Reference counting already retires rows as their last holder
      // settles; this catches anything an unforeseen path left behind, and keeps
      // the invariant "idle means `records` holds exactly what is on screen"
      // true by construction rather than by argument.
      retiredRowIds.clear();
      if (records.size !== order.length) {
        for (const [id, row] of records) {
          if (!row.visible) records.delete(id);
        }
      }
    }
  }

  async function add(item: T, asyncAction: () => Promise<T>): Promise<void> {
    const opId = ++nextOpId;
    // PREPARE — nothing user-controlled, nothing observable yet.
    const row: Row<T> = { id: nextRowId++, key: nextKey++, base: item, claims: [], visible: false, refs: 1 };
    const claim = stake(row, opId, item);

    // COMMIT + PUBLISH.
    commit(() => {
      records.set(row.id, row);
      row.visible = true;
      order = [...order, row.id];
      inflight++;
      return true;
    });
    // Fully committed. Subscribers have run; anything they started is live.

    let result: T | undefined;
    let failed = false;
    try {
      result = await asyncAction();
    } catch {
      failed = true;
    }

    commit(() => {
      try {
        if (failed) {
          // Existence is owned by this add. Revoke first: a concurrent `remove`
          // may already have recorded this row for a possible rollback, and
          // reinstating a row whose insert failed would put a phantom item back
          // on screen.
          retiredRowIds.add(row.id);
          dropClaim(row, claim);
          return hide(row.id);
        }
        // Addressed through `records`, so a row a pending `remove` has hidden is
        // still reachable and the confirmed value is not lost. The claim resolves
        // in place; if a newer operation has claimed the row since, that claim
        // stays on top and nothing visible changes yet.
        const before = effectiveValue(row);
        claim.value = result as T;
        claim.settled = true;
        collapse(row);
        return row.visible && !Object.is(before, effectiveValue(row));
      } finally {
        settle([row.id]);
      }
    });
  }

  async function remove(predicate: (item: T) => boolean, asyncAction: () => Promise<void>): Promise<void> {
    const opId = ++nextOpId;
    // PREPARE — `predicate` is user code and may throw, or may even re-enter
    // this list. Only IDS are recorded, never values: a rollback reinstates the
    // row as it stands at that moment, which is what lets an `add` or `update`
    // that settled while the row was hidden still be reflected. The predicate
    // sees the list as of this operation's invocation, so an operation it starts
    // itself cannot change what it matches.
    const matchedIds: number[] = [];
    for (const id of order) {
      if (predicate(valueBelow(records.get(id) as Row<T>, opId))) matchedIds.push(id);
    }

    commit(() => {
      retain(matchedIds);
      inflight++;
      if (matchedIds.length === 0) return false;
      const removing = new Set(matchedIds);
      for (const id of matchedIds) {
        const row = records.get(id);
        if (row) row.visible = false;
      }
      // Recomputed from the LIVE order rather than a snapshot taken during
      // preparation, so a row a reentrant predicate added is not erased here.
      order = order.filter((id) => !removing.has(id));
      return true;
    });

    let failed = false;
    try {
      await asyncAction();
    } catch {
      failed = true;
    }

    commit(() => {
      try {
        if (!failed) {
          // The deletion is confirmed. Retiring the rows stops any OTHER
          // operation that also matched them — reachable when a predicate
          // re-enters the list — from reinstating them through its own rollback.
          for (const id of matchedIds) retiredRowIds.add(id);
          return false;
        }
        // Anything added, changed or successfully removed since is left alone —
        // a failing remove has no claim on it.
        return restore(matchedIds);
      } finally {
        settle(matchedIds);
      }
    });
  }

  async function updateItem(
    predicate: (item: T) => boolean,
    patch: Partial<T>,
    asyncAction: () => Promise<T>,
  ): Promise<void> {
    const opId = ++nextOpId;
    // PREPARE — both the predicate AND the patch spread run here. Object spread
    // executes the patch's property getters, so this is user code that can throw
    // AND that can re-enter this list. Nothing is mutated, claimed, retained or
    // counted until every row has been prepared successfully: a throw at any
    // point leaves no reservation for this operation, while an operation the
    // user code started in the meantime is entirely unaffected.
    //
    // Values are read through `valueBelow`, so this operation prepares from the
    // list as of its own invocation. Reading the top claim instead would compute
    // this operation's optimistic value — and therefore its eventual fallback —
    // from a value a newer operation invented.
    const prepared: Array<{ row: Row<T>; nextValue: T }> = [];
    for (const id of order) {
      const row = records.get(id) as Row<T>;
      const seen = valueBelow(row, opId);
      if (!predicate(seen)) continue;
      prepared.push({ row, nextValue: { ...seen, ...patch } as T });
    }
    const preparedIds = prepared.map((p) => p.row.id);

    // COMMIT + PUBLISH. Each claim goes in at this operation's ordered position,
    // so a claim staked by an operation the PREPARE above started sits ABOVE it
    // even though that operation committed first.
    const claims: Claim<T>[] = [];
    commit(() => {
      retain(preparedIds);
      inflight++;
      let visibleChanged = false;
      for (const p of prepared) {
        const before = effectiveValue(p.row);
        claims.push(stake(p.row, opId, p.nextValue));
        if (p.row.visible && !Object.is(before, effectiveValue(p.row))) visibleChanged = true;
      }
      return visibleChanged;
    });

    let result: T | undefined;
    let failed = false;
    try {
      result = await asyncAction();
    } catch {
      failed = true;
    }

    commit(() => {
      try {
        let visibleChanged = false;
        // Iterate the claims actually staked, not the prepared plan. They are
        // pushed in prepared order so the indices align, but keying off the
        // claims means a settlement can never dereference one that was not
        // installed.
        for (let i = 0; i < claims.length; i++) {
          const row = prepared[i].row;
          const claim = claims[i];
          const before = effectiveValue(row);
          if (failed) {
            // Drop this operation's claim and nothing else, revealing whatever
            // is beneath: an older operation's optimistic value while it is
            // still pending, its confirmed value once it has succeeded, or the
            // original value.
            dropClaim(row, claim);
          } else {
            claim.value = result as T;
            claim.settled = true;
          }
          collapse(row);
          if (row.visible && !Object.is(before, effectiveValue(row))) visibleChanged = true;
        }
        return visibleChanged;
      } finally {
        settle(preparedIds);
      }
    });
  }

  return {
    items,
    pending,
    add,
    remove,
    update: updateItem,
  };
}
