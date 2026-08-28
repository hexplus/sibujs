import { signal } from "../core/signals/signal";

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

/** One tracked row. Never exposed; `items()` projects `value`. */
interface Row<T> {
  /** Stable identity, independent of value and of visibility. */
  readonly id: number;
  /**
   * Monotonic ordering token. Allocated once and never reused, so `visible`
   * sorted by key is an invariant maintained by construction: `add` appends the
   * largest key, removal preserves relative order, and restoration is an ordered
   * insert.
   */
  readonly key: number;
  value: T;
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
 *   - a successful `remove` retires its rows; the records are dropped once the
 *     list goes idle and nothing can reference them;
 *   - a failed `update` restores only the rows it still owns, including their
 *     previous owner;
 *   - a successful `update` publishes only to the rows it still owns.
 *
 * Operations on disjoint rows are completely independent, and no operation can
 * revert, overwrite or resurrect work it did not do. Where two operations touch
 * the same row, the later one wins: it claims the row, and the earlier one's
 * settlement — success or failure — becomes a no-op for that row.
 *
 * `pending()` is true while any operation is unsettled and becomes false exactly
 * when the last one settles, in any settlement order.
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

  /**
   * The ids currently on screen, in display order.
   *
   * Always sorted by `key`. That invariant is what makes restoration an ordered
   * insert rather than a guess at an absolute position.
   */
  let visible: number[] = [];

  for (const value of initialValue) {
    const row: Row<T> = { id: nextRowId++, key: nextKey++, value, refs: 0, owner: 0 };
    records.set(row.id, row);
    visible.push(row.id);
  }

  const [items, setItems] = signal<T[]>(visible.map((id) => (records.get(id) as Row<T>).value));
  const [pending, setPending] = signal(false);
  let inflight = 0;

  /**
   * Rows whose creating `add` failed, so they must never come back.
   *
   * A `remove` records the rows it took out so it can reinstate them if the
   * deletion fails. If one of those rows belonged to an `add` that then failed,
   * reinstating it would resurrect an item that was never persisted — a failed
   * operation's artifact reappearing by way of a second operation's rollback.
   *
   * Bounded by construction: it can only hold ids while other operations are in
   * flight, and `settle()` empties it the moment the list goes idle.
   */
  const revokedRowIds = new Set<number>();

  /** Republish the public projection. Called after every visible change. */
  function publish(): void {
    setItems(visible.map((id) => (records.get(id) as Row<T>).value));
  }

  /** Insert `id` into `visible` at the position its ordering key implies. */
  function insertByKey(id: number): void {
    const key = (records.get(id) as Row<T>).key;
    let at = visible.length;
    for (let i = 0; i < visible.length; i++) {
      if ((records.get(visible[i]) as Row<T>).key > key) {
        at = i;
        break;
      }
    }
    visible = [...visible.slice(0, at), id, ...visible.slice(at)];
  }

  function hide(id: number): boolean {
    const at = visible.indexOf(id);
    if (at === -1) return false;
    visible = [...visible.slice(0, at), ...visible.slice(at + 1)];
    return true;
  }

  /**
   * Mark an operation in flight.
   *
   * Deliberately SEPARATE from allocating the operation id, and deliberately
   * called only after the synchronous optimistic mutation has succeeded. A
   * user-supplied `predicate` runs during that mutation and may throw; if the
   * inflight count had already been incremented, that throw would propagate to
   * the caller with no `finally` to undo it and `pending()` would stay true
   * forever. Nothing between here and the `try` can throw.
   */
  function begin(): void {
    inflight++;
    setPending(true);
  }

  /** Claim the right to settle against these rows later. */
  function retain(ids: Iterable<number>): void {
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
   * than only at moments of idleness.
   */
  function release(ids: Iterable<number>): void {
    for (const id of ids) {
      const row = records.get(id);
      if (!row) continue;
      row.refs--;
      if (row.refs <= 0 && !visible.includes(id)) {
        records.delete(id);
        revokedRowIds.delete(id);
      }
    }
  }

  function settle(heldIds: Iterable<number>): void {
    release(heldIds);
    inflight--;
    if (inflight <= 0) {
      inflight = 0;
      // Backstop. Reference counting already retires rows as their last holder
      // settles; this catches anything an unforeseen path left behind, and keeps
      // the invariant "idle means `records` holds exactly what is on screen"
      // true by construction rather than by argument.
      revokedRowIds.clear();
      if (records.size !== visible.length) {
        const live = new Set(visible);
        for (const id of records.keys()) {
          if (!live.has(id)) records.delete(id);
        }
      }
      setPending(false);
    }
  }

  async function add(item: T, asyncAction: () => Promise<T>): Promise<void> {
    const opId = ++nextOpId;
    const row: Row<T> = { id: nextRowId++, key: nextKey++, value: item, refs: 1, owner: opId };
    records.set(row.id, row);
    visible = [...visible, row.id];
    // `begin()` precedes `publish()` so a subscriber woken by the publication
    // observes `pending() === true`. Nothing here can throw, so there is no
    // risk of leaking the inflight slot (see `begin`).
    begin();
    publish();

    try {
      const result = await asyncAction();
      // Addressed through `records`, so a row a pending `remove` has hidden is
      // still reachable and the confirmed value is not lost. Publish only if no
      // later operation has claimed the value.
      const current = records.get(row.id);
      if (current && current.owner === opId) {
        current.value = result;
        if (visible.includes(row.id)) publish();
      }
    } catch {
      // Existence is owned by this add. Revoke first: a concurrent `remove` may
      // already have recorded this row for a possible rollback, and reinstating
      // a row whose insert failed would put a phantom item back on screen.
      revokedRowIds.add(row.id);
      if (hide(row.id)) publish();
    } finally {
      settle([row.id]);
    }
  }

  async function remove(predicate: (item: T) => boolean, asyncAction: () => Promise<void>): Promise<void> {
    // Record only the IDS taken out — never their values. A rollback reinstates
    // the row as it stands at that moment, which is what lets an `add` or
    // `update` that settled while the row was hidden still be reflected.
    // `predicate` is user code and may throw, which is why this runs BEFORE
    // `begin()`.
    const removedIds: number[] = [];
    const kept: number[] = [];
    for (const id of visible) {
      if (predicate((records.get(id) as Row<T>).value)) removedIds.push(id);
      else kept.push(id);
    }
    // Claim the rows before publishing, so a subscriber woken by the
    // publication cannot see a row retired out from under this operation.
    retain(removedIds);
    begin();
    if (removedIds.length > 0) {
      visible = kept;
      publish();
    }

    try {
      await asyncAction();
    } catch {
      // Reinstate by ordering key, so each row returns to its place relative to
      // the rows that are actually still present. Anything added, changed or
      // successfully removed since is left alone — a failing remove has no claim
      // on it.
      let restored = false;
      for (const id of removedIds) {
        // Already back (another failed remove reinstated it), revoked by a
        // failed `add`, or purged — either way this operation must not insert it.
        if (visible.includes(id)) continue;
        if (revokedRowIds.has(id)) continue;
        if (!records.has(id)) continue;
        insertByKey(id);
        restored = true;
      }
      if (restored) publish();
    } finally {
      settle(removedIds);
    }
  }

  async function updateItem(
    predicate: (item: T) => boolean,
    patch: Partial<T>,
    asyncAction: () => Promise<T>,
  ): Promise<void> {
    const opId = ++nextOpId;
    // Claim each matching row and remember what it held, so a rollback restores
    // that row alone — including its previous owner, so an even older
    // operation's claim is not silently transferred to this one. `predicate` is
    // user code and may throw, so the whole claim phase runs BEFORE `begin()`
    // and mutates nothing until it has completed.
    const matched: Array<{ row: Row<T>; previousValue: T; previousOwner: number }> = [];
    for (const id of visible) {
      const row = records.get(id) as Row<T>;
      if (!predicate(row.value)) continue;
      matched.push({ row, previousValue: row.value, previousOwner: row.owner });
    }
    const matchedIds = matched.map((m) => m.row.id);
    retain(matchedIds);
    begin();
    for (const { row } of matched) {
      row.value = { ...row.value, ...patch } as T;
      row.owner = opId;
    }
    if (matched.length > 0) publish();

    try {
      const result = await asyncAction();
      let touchedVisible = false;
      for (const { row } of matched) {
        // Still ours? A later operation may have claimed this row since. The row
        // is addressed directly, so a row hidden by a pending `remove` still
        // receives its confirmed value.
        if (row.owner !== opId) continue;
        row.value = result;
        if (visible.includes(row.id)) touchedVisible = true;
      }
      if (touchedVisible) publish();
    } catch {
      let touchedVisible = false;
      for (const { row, previousValue, previousOwner } of matched) {
        if (row.owner !== opId) continue;
        row.value = previousValue;
        row.owner = previousOwner;
        if (visible.includes(row.id)) touchedVisible = true;
      }
      if (touchedVisible) publish();
    } finally {
      settle(matchedIds);
    }
  }

  return {
    items,
    pending,
    add,
    remove,
    update: updateItem,
  };
}
