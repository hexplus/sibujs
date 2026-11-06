import { type HeldCheck, holdSubtree } from "../../reactivity/track";

// ---------------------------------------------------------------------------
// Committing a built result into a renderer, gated on a lifecycle.
//
// Between "the lifecycle is active and the renderer still owns this" and the
// insertion, two steps run application code: releasing the hold on the result
// (its skipped bindings catch up, synchronously) and tearing down the outgoing
// content (its disposers). Either can pause or end the lifecycle, dispose the
// renderer, or supersede its pass. So neither is a passive step: everything is
// checked again after each one, and the insertion itself runs nothing but DOM
// operations, right after the last check.
// ---------------------------------------------------------------------------

const NOOP = (): void => {};

/** Where a renderer keeps the cancel of the commit in progress, if any. @internal */
export interface CommitSlot {
  cancel: () => void;
}

/** One gated commit; see {@link commitWhenActive}. @internal */
export interface HeldCommit {
  /** The lifecycle the result belongs to: its state, and a wait for it to resume or end. */
  held: Pick<HeldCheck, "state" | "wait">;
  /** The built result, held while the lifecycle is paused; `null`: nothing to hold. */
  node: Node | null;
  /** Whether the renderer still owns this commit: alive, its pass still current. */
  owned?: () => boolean;
  /**
   * One step of the outgoing teardown: returns `true` when it ran one (it is
   * application code: everything is checked again), `false` when nothing is
   * left. A step that ran is never repeated.
   */
  teardown?: () => boolean;
  /** The insertion: DOM operations and bookkeeping only. Reads its destination fresh. */
  insert: () => void;
  /** Dispose the result: ownership was lost or the lifecycle ended. Runs before the hold is released. */
  discard: () => void;
}

/**
 * Insert `c.node` once `c.held` is active, the renderer owns the commit, the
 * result has caught up and the outgoing content is torn down — re-checked
 * after every step that can run application code:
 *
 * - paused (now, or again after a step): the result is held (its bindings do
 *   not react) and the commit waits for the next resume — event-driven, no
 *   polling; steps already done are not repeated;
 * - ended, or not owned any more: `discard` runs, once, and nothing is
 *   inserted;
 * - `slot.cancel()` discards it at any point until it was inserted or
 *   discarded — during the catch-up and the teardown too.
 *
 * Exactly one of `insert` / `discard` runs, at most once. Nothing is rebuilt.
 *
 * @internal
 */
export function commitWhenActive(slot: CommitSlot, c: HeldCommit): void {
  let over = false;
  let unhold: (() => void) | null = null;
  let drop = NOOP;
  const finish = (): void => {
    over = true;
    if (slot.cancel === cancel) slot.cancel = NOOP;
    drop();
    drop = NOOP;
  };
  const cancel = (): void => {
    if (over) return;
    finish();
    const release = unhold;
    unhold = null;
    try {
      c.discard();
    } finally {
      release?.();
    }
  };
  const attempt = (): void => {
    drop = NOOP;
    while (!over) {
      const state = c.held.state();
      if (state === 2 || (c.owned !== undefined && !c.owned())) {
        cancel();
        return;
      }
      if (state === 1) {
        if (c.node !== null && unhold === null) unhold = holdSubtree(c.node);
        // Paused right now: `wait` registers, and calls back on the next
        // resume or the end.
        drop = c.held.wait(attempt, attempt);
        return;
      }
      if (unhold !== null) {
        // The catch-up: application code.
        const release = unhold;
        unhold = null;
        release();
        continue;
      }
      if (c.teardown?.() === true) continue;
      finish();
      c.insert();
      return;
    }
  };
  slot.cancel = cancel;
  attempt();
}
