import { type HeldCheck, holdSubtree } from "../../reactivity/track";

// ---------------------------------------------------------------------------
// Committing a built result into a renderer, gated on a lifecycle.
//
// No DOM operation here is passive. Releasing the hold on the result runs its
// skipped bindings (they catch up, synchronously); tearing down the outgoing
// content runs its disposers; and removing or inserting a custom element runs
// its `disconnectedCallback` / `connectedCallback` synchronously, before the
// operation returns. Any of these can pause or end the lifecycle, dispose the
// renderer, supersede its pass, or cancel the commit. So everything is checked
// again after each step before the insertion. The insertion can run such a
// callback too, so a renderer records what it inserts as its content *before*
// the DOM operation: a disposal running inside the insertion reaches it.
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
   * One step of the outgoing teardown: returns `true` when it ran one, `false`
   * when nothing is left. Either way it may have run application code (a
   * step that only detaches the incoming nodes runs their
   * `disconnectedCallback`), so everything is checked again after every call;
   * a call returning `false` is not repeated unless the commit waits for a
   * resume meanwhile. A step that ran is never repeated.
   */
  teardown?: () => boolean;
  /**
   * The insertion. Reads its destination fresh, and records the result as the
   * renderer's content BEFORE the DOM operation: inserting a custom element
   * runs its `connectedCallback`, which may dispose the renderer, and that
   * disposal must reach the result. The commit is over by then: a `cancel`
   * from inside it is a no-op, and it is the renderer's cleanup that releases
   * the result.
   */
  insert: () => void;
  /** Dispose the result: ownership was lost or the lifecycle ended. Runs before the hold is released. */
  discard: () => void;
}

/**
 * Insert `c.node` once `c.held` is active, the renderer owns the commit, the
 * result has caught up and the outgoing content is torn down — re-checked
 * after every step that can run application code, each teardown call
 * included, whatever it returns:
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
    // Set once a teardown call reported nothing left: the checks then run once
    // more — that call may have run application code too — and the insertion
    // follows. Reset by a wait: a resume tears down again.
    let clean = false;
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
      if (!clean) {
        clean = c.teardown?.() !== true;
        continue;
      }
      finish();
      c.insert();
      return;
    }
  };
  slot.cancel = cancel;
  attempt();
}
