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
// id and the id of the operation that last claimed its value. An operation
// records only the rows it touched and, on settlement, re-checks ownership row
// by row. Disjoint operations therefore never interact, and an operation can
// only ever undo its own mutation.
//
// `items()` projects `value` out of the ledger, so no id, generation or wrapper
// is observable through the public API.

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

/** One tracked row. Never exposed; `items()` projects `value`. */
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
  value: T;
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
  /**
   * The operation that last claimed this row's VALUE.
   *
   * Existence is owned separately: a row created by `add` is withdrawn by that
   * same add's failure whatever its value-ownership has become, because an
   * insert that never succeeded was never a real row. Only the value can be
   * re-claimed by a later operation.
   */
  owner: number;
}

/**
 * optimisticList provides optimistic updates for array state.
 *
 * CONCURRENCY MODEL — per-row, per-operation ownership.
 *
 * Every operation gets an id, and every row records which operation last
 * claimed its value. On settlement an operation re-checks each row it touched:
 *
 *   - a failed `add` withdraws exactly the row it inserted, and marks it so a
 *     concurrent failed `remove` cannot reinstate it;
 *   - a successful `add` publishes into its own row, unless a later operation
 *     has since claimed that row's value — and it lands even if the row is
 *     temporarily hidden by a pending `remove`;
 *   - a failed `remove` makes its rows visible again, in their correct relative
 *     order and carrying whatever value they hold NOW, not the value they held
 *     when they were taken out;
 *   - a successful `remove` retires its rows; each record is dropped as soon as
 *     its last holder settles;
 *   - a failed `update` restores only the rows it still owns, including their
 *     previous owner;
 *   - a successful `update` publishes only to the rows it still owns.
 *
 * Operations on disjoint rows are completely independent, and no operation can
 * revert, overwrite or resurrect work it did not do. Where two operations touch
 * the same row, the later one wins — including when the later one was started
 * by a reactive subscriber woken by the earlier one.
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
    const row: Row<T> = { id: nextRowId++, key: nextKey++, value, visible: true, refs: 0, owner: 0 };
    records.set(row.id, row);
    order.push(row.id);
  }

  const [items, setItems] = signal<T[]>(order.map((id) => (records.get(id) as Row<T>).value));
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
    for (let i = 0; i < order.length; i++) out[i] = (records.get(order[i]) as Row<T>).value;
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
    const row: Row<T> = { id: nextRowId++, key: nextKey++, value: item, visible: false, refs: 1, owner: opId };

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
          return hide(row.id);
        }
        // Addressed through `records`, so a row a pending `remove` has hidden is
        // still reachable and the confirmed value is not lost. Publish only if
        // no later operation has claimed the value.
        const current = records.get(row.id);
        if (!current || current.owner !== opId) return false;
        current.value = result as T;
        return current.visible;
      } finally {
        settle([row.id]);
      }
    });
  }

  async function remove(predicate: (item: T) => boolean, asyncAction: () => Promise<void>): Promise<void> {
    // PREPARE — `predicate` is user code and may throw, or may even re-enter
    // this list. Only IDS are recorded, never values: a rollback reinstates the
    // row as it stands at that moment, which is what lets an `add` or `update`
    // that settled while the row was hidden still be reflected.
    const matchedIds: number[] = [];
    for (const id of order) {
      if (predicate((records.get(id) as Row<T>).value)) matchedIds.push(id);
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
    // executes the patch's property getters, so this is user code that can
    // throw; doing it after the inflight slot was taken leaked `pending()` as
    // true forever. Nothing is mutated, retained or counted until every row has
    // been prepared successfully.
    const prepared: Array<{ row: Row<T>; previousValue: T; previousOwner: number; nextValue: T }> = [];
    for (const id of order) {
      const row = records.get(id) as Row<T>;
      if (!predicate(row.value)) continue;
      const nextValue = { ...row.value, ...patch } as T;
      prepared.push({ row, previousValue: row.value, previousOwner: row.owner, nextValue });
    }
    const preparedIds = prepared.map((p) => p.row.id);

    commit(() => {
      retain(preparedIds);
      inflight++;
      let visibleChanged = false;
      for (const p of prepared) {
        p.row.value = p.nextValue;
        p.row.owner = opId;
        if (p.row.visible) visibleChanged = true;
      }
      return visibleChanged;
    });
    // Fully committed. A subscriber woken here may claim these rows, and this
    // operation will not take them back.

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
        for (const p of prepared) {
          // Still ours? A later operation — possibly one a subscriber started
          // during this operation's own publication — may have claimed the row.
          // The row is addressed directly, so a row hidden by a pending `remove`
          // still receives its confirmed value.
          if (p.row.owner !== opId) continue;
          if (failed) {
            p.row.value = p.previousValue;
            p.row.owner = p.previousOwner;
          } else {
            p.row.value = result as T;
          }
          if (p.row.visible) visibleChanged = true;
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
