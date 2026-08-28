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

/** One tracked row. Never exposed; `items()` projects `value`. */
interface Row<T> {
  /** Stable identity, independent of the value. Survives value replacement. */
  readonly id: number;
  value: T;
  /**
   * The operation that last claimed this row's VALUE.
   *
   * Existence is owned separately: a row created by `add` is removed by that
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
 *   - a failed `add` removes exactly the row it inserted;
 *   - a successful `add` publishes into its own row, unless a later operation
 *     has since claimed that row's value;
 *   - a failed `remove` restores exactly the rows it removed, at their original
 *     positions, without disturbing anything added or changed since;
 *   - a successful `remove` alters nothing further;
 *   - a failed `update` restores only the rows it still owns, including their
 *     previous owner;
 *   - a successful `update` publishes only to the rows it still owns.
 *
 * Operations on disjoint rows are completely independent, and no operation can
 * revert, overwrite or resurrect work it did not do. Where two operations do
 * touch the same row, the later one wins: it claims the row, and the earlier
 * one's settlement — success or failure — becomes a no-op for that row.
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
  let nextOpId = 0;

  /**
   * The ledger. Row identity lives here and nowhere else — no `WeakMap`, no
   * `Object.is` fallback — so primitives, duplicate primitives and duplicate
   * object references are all individually addressable. The previous
   * implementation fell back to `Object.is` for non-objects, which located the
   * FIRST equal value: given `[1]` and an optimistic `add(1)` confirmed as `10`,
   * it rewrote index 0 and produced `[10, 1]`.
   *
   * It is also the only long-lived structure here. Per-operation bookkeeping
   * lives in closure locals that become garbage the moment the operation
   * settles, so nothing accumulates across settled operations.
   */
  let rows: Row<T>[] = initialValue.map((value) => ({ id: nextRowId++, value, owner: 0 }));

  const [items, setItems] = signal<T[]>(rows.map((r) => r.value));
  const [pending, setPending] = signal(false);
  let inflight = 0;

  /**
   * Rows whose creating `add` failed, so they must never come back.
   *
   * A `remove` captures the rows it takes out so it can reinstate them if the
   * deletion fails. If one of those rows belonged to an `add` that then failed,
   * reinstating it would resurrect an item that was never persisted — a failed
   * operation's artifact reappearing by way of a second operation's rollback.
   *
   * Bounded by construction: it can only hold ids while other operations are
   * still in flight, and `settle()` empties it the moment the list goes idle, so
   * it cannot accumulate across settled operations.
   */
  const revokedRowIds = new Set<number>();

  /** Republish the public projection. Called after every ledger mutation. */
  function publish(): void {
    setItems(rows.map((r) => r.value));
  }

  function indexOfRow(id: number): number {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].id === id) return i;
    }
    return -1;
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

  function settle(): void {
    inflight--;
    if (inflight <= 0) {
      inflight = 0;
      // Nothing is in flight, so nothing can still be holding a capture that
      // would consult these. Clearing here is what keeps the set bounded.
      revokedRowIds.clear();
      setPending(false);
    }
  }

  async function add(item: T, asyncAction: () => Promise<T>): Promise<void> {
    const opId = ++nextOpId;
    const row: Row<T> = { id: nextRowId++, value: item, owner: opId };
    rows = [...rows, row];
    publish();
    begin();

    try {
      const result = await asyncAction();
      const idx = indexOfRow(row.id);
      // Publish only if the row still exists AND no later operation has claimed
      // its value. An older success must not overwrite a newer mutation.
      if (idx >= 0 && rows[idx].owner === opId) {
        rows = [...rows];
        rows[idx] = { ...rows[idx], value: result };
        publish();
      }
    } catch {
      // Existence is owned by this add, so the row goes whatever its value
      // ownership has become: an insert that never succeeded was never a real
      // row. A later operation's settlement finds it gone and correctly does
      // nothing for it.
      // Revoke first: a concurrent `remove` may have already captured this row
      // for a possible rollback, and reinstating a row whose insert failed would
      // put a phantom item back on screen.
      revokedRowIds.add(row.id);
      const idx = indexOfRow(row.id);
      if (idx >= 0) {
        rows = [...rows.slice(0, idx), ...rows.slice(idx + 1)];
        publish();
      }
    } finally {
      settle();
    }
  }

  async function remove(predicate: (item: T) => boolean, asyncAction: () => Promise<void>): Promise<void> {
    // Record the rows themselves plus where they sat, so a rollback reinstates
    // exactly those rows rather than an entire stale array. `predicate` is user
    // code and may throw — which is why this runs BEFORE `begin()`.
    const removed: Array<{ index: number; row: Row<T> }> = [];
    const kept: Row<T>[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (predicate(rows[i].value)) removed.push({ index: i, row: rows[i] });
      else kept.push(rows[i]);
    }
    if (removed.length > 0) {
      rows = kept;
      publish();
    }
    begin();

    try {
      await asyncAction();
    } catch {
      // Reinstate only rows that are still absent, at their original positions
      // clamped to the current length. Anything added or changed since is left
      // alone — a failing remove has no claim on it.
      let restored = false;
      for (const { index, row } of removed) {
        // Already back (another failed remove restored it), or revoked by a
        // failed `add` — either way this operation must not insert it.
        if (indexOfRow(row.id) !== -1) continue;
        if (revokedRowIds.has(row.id)) continue;
        const at = Math.min(index, rows.length);
        rows = [...rows.slice(0, at), row, ...rows.slice(at)];
        restored = true;
      }
      if (restored) publish();
    } finally {
      settle();
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
    // user code and may throw, so this runs BEFORE `begin()`; `rows` is only
    // reassigned once the whole map has succeeded.
    const claimed = new Map<number, { previousValue: T; previousOwner: number }>();
    rows = rows.map((row) => {
      if (!predicate(row.value)) return row;
      claimed.set(row.id, { previousValue: row.value, previousOwner: row.owner });
      return { ...row, value: { ...row.value, ...patch } as T, owner: opId };
    });
    if (claimed.size > 0) publish();
    begin();

    try {
      const result = await asyncAction();
      let published = false;
      rows = rows.map((row) => {
        // Still ours? A later operation may have claimed this row since.
        if (!claimed.has(row.id) || row.owner !== opId) return row;
        published = true;
        return { ...row, value: result };
      });
      if (published) publish();
    } catch {
      let reverted = false;
      rows = rows.map((row) => {
        const claim = claimed.get(row.id);
        if (!claim || row.owner !== opId) return row;
        reverted = true;
        return { ...row, value: claim.previousValue, owner: claim.previousOwner };
      });
      if (reverted) publish();
    } finally {
      settle();
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
