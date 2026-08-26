import { reportError } from "../core/errors";
import type { ReactiveSignal } from "./signal";

// ---------------------------------------------------------------------------
// Reactivity core — doubly-linked-list subscription edges.
//
// Each (signal, subscriber) pair is represented by a `SubNode` allocated once
// and spliced into two lists:
//
//   signal.subsHead ─▶ node ─▶ node ─▶ ...      (via sigNext)
//                      ↑
//   subscriber.depsHead ─▶ node ─▶ node ─▶ ...  (via subNext)
//
// This replaces the prior `Set<Subscriber>` on signals plus `Map<Signal,
// epoch>` on subscribers. Wins:
//
//  * O(1) subscribe and O(1) unsubscribe (no hash ops, pointer splice)
//  * Cache-friendly pointer traversal in propagate / notify / cleanup
//  * One allocation per edge instead of two (was Set entry + Map entry)
//  * A node pool eliminates per-edge GC pressure on create/destroy churn
//
// The `__f` single-subscriber cache is no longer needed — a signal with one
// subscriber IS a one-step linked list walk, which already beats the prior
// Set iteration. `__sc` (subscriber count) is maintained for O(1) devtools
// reads.
//
// ---------------------------------------------------------------------------
// This module holds the IMPLEMENTATIONS and their module-local coordination
// state. It is consumed only through `./track.ts`, which on first load
// publishes these functions on a `globalThis` registry and on every subsequent
// (duplicate) load re-exports the first copy's functions instead. That makes
// exactly one copy's code run — using plain module-local `let`/`const` state,
// byte-identical to a single-instance build — so duplicate reactive runtimes
// (as produced by bundler dependency pre-bundling) all coordinate through one
// source of truth without any hot-path indirection. See ./track.ts for why.
// ---------------------------------------------------------------------------

type Subscriber = () => void;

// ---------- Subscription edge ---------------------------------------------

interface SubNode {
  // The edge endpoints — null only while the node is sitting in the free pool.
  sig: ReactiveSignal | null;
  sub: Subscriber | null;
  // Epoch stamp refreshed on every recordDependency() call. `retrack()` uses
  // this to detect deps that were present before the run but not re-read.
  epoch: number;
  // The signal's `__v` at the moment this subscriber last OBSERVED it.
  //
  // WHY: invalidation is not notification. `propagateDirty` enqueues every
  // downstream effect as soon as an upstream source dirties a computed —
  // before the computed has recomputed and decided whether its own output
  // actually changed. Comparing this stamp against the signal's current
  // version just before the effect runs is what lets `derived({ equals })`
  // stop propagation instead of merely deduplicating it.
  //
  // `NaN` means "unversioned source": NaN !== anything, so such a dependency
  // always counts as changed. That is the safe default for any reactive token
  // that does not maintain `__v` (see `depsChanged`).
  depVersion: number;
  // Doubly-linked into signal.subsHead (most-recent-first insertion order).
  sigPrev: SubNode | null;
  sigNext: SubNode | null;
  // Doubly-linked into subscriber.depsHead (record order).
  subPrev: SubNode | null;
  subNext: SubNode | null;
  // Saved value of `signal.__activeNode` from when THIS node was activated —
  // lets nested tracking runs restore the outer context's active marker when
  // they finish, and lets recordDependency refresh existing edges in O(1).
  prevActive: SubNode | null;
}

type SignalWithList = ReactiveSignal & {
  subsHead?: SubNode | null;
  subsTail?: SubNode | null;
  __sc?: number;
  __name?: string;
  // Pointer to the subscription edge whose subscriber is CURRENTLY mid-eval.
  // Non-null only during a tracking run. Gives recordDependency O(1)
  // "have I already recorded this signal for the current sub?" detection
  // without walking the subscriber's dep list.
  __activeNode?: SubNode | null;
  // Monotonic version, bumped ONLY when the source's value actually changed.
  // `signal()` bumps it on a non-equal write; `derived()` bumps it only when a
  // recompute produced a value its comparator considers different. Absent on
  // unversioned reactive tokens, which `depsChanged` treats as always-changed.
  __v?: number;
  // Set on computeds by `derived()`. `_d` is the dirty flag; `_validate`
  // recomputes a dirty computed and refreshes `__v`. The drain calls it to
  // settle a computed's value BEFORE deciding whether dependents must run.
  _d?: boolean;
  _validate?: () => void;
};

// ---------- Node pool -----------------------------------------------------
//
// High-churn workloads (create/destroy cycles, wide track()+cleanup) allocate
// many edges. Pooling avoids GC pressure by reusing node objects. Cap the
// pool so a pathological spike doesn't retain memory forever.
//
// Shape-stable allocation in `createNode`: every node is born with the same
// hidden class, which matters for V8 inline caches on property reads.
// ---------------------------------------------------------------------------
const POOL_MAX = 4096;
const nodePool: SubNode[] = [];

function createNode(): SubNode {
  return {
    sig: null,
    sub: null,
    epoch: 0,
    depVersion: 0,
    sigPrev: null,
    sigNext: null,
    subPrev: null,
    subNext: null,
    prevActive: null,
  };
}

function allocNode(sig: ReactiveSignal, sub: Subscriber, epoch: number): SubNode {
  const n = nodePool.pop();
  if (n) {
    n.sig = sig;
    n.sub = sub;
    n.epoch = epoch;
    // prev/next pointers left over from last life are overwritten by link ops.
    return n;
  }
  const fresh = createNode();
  fresh.sig = sig;
  fresh.sub = sub;
  fresh.epoch = epoch;
  return fresh;
}

function freeNode(node: SubNode): void {
  node.sig = null;
  node.sub = null;
  node.sigPrev = null;
  node.sigNext = null;
  node.subPrev = null;
  node.subNext = null;
  node.prevActive = null;
  if (nodePool.length < POOL_MAX) nodePool.push(node);
}

// ---------- List splice helpers -------------------------------------------
//
// Inlined by the JIT in most call sites but factored for correctness — a
// single point of truth for each list's prev/next/head/tail invariant.
// ---------------------------------------------------------------------------

function linkSignal(sig: SignalWithList, node: SubNode): void {
  // Insert at the HEAD of signal.subsHead. O(1).
  //
  // NOTE ON FIRING ORDER: because subscribers are prepended and the notify
  // paths walk subsHead → tail, sibling effects/bindings observing the same
  // signal fire in *reverse subscription order* (most-recently-subscribed
  // first / LIFO). This is an intentional consequence of O(1) head insertion.
  // The system is still glitch-free and converges (computeds are pulled lazily;
  // effects run to a fixed point), so correctness does not depend on order —
  // but do NOT rely on two sibling effects running in declaration order.
  const oldHead = sig.subsHead ?? null;
  node.sigPrev = null;
  node.sigNext = oldHead;
  if (oldHead) oldHead.sigPrev = node;
  else sig.subsTail = node;
  sig.subsHead = node;
  sig.__sc = (sig.__sc ?? 0) + 1;
}

function unlinkSignal(node: SubNode): void {
  const sig = node.sig as SignalWithList | null;
  if (!sig) return;
  const prev = node.sigPrev;
  const next = node.sigNext;
  if (prev) prev.sigNext = next;
  else sig.subsHead = next;
  if (next) next.sigPrev = prev;
  else sig.subsTail = prev;
  sig.__sc = (sig.__sc ?? 1) - 1;
  // If the signal currently holds `node` as its active marker (rare — only
  // if we unlink mid-eval, e.g. during pruneStaleDeps), restore to the
  // saved prior marker so outer tracking contexts keep working.
  if (sig.__activeNode === node) sig.__activeNode = node.prevActive;
  // When a signal has no subscribers at all, clear the head/tail slots so
  // isolated signals don't pin stale node references through their state
  // objects' hidden class slots.
  if (sig.__sc === 0) {
    sig.subsHead = null;
    sig.subsTail = null;
  }
}

function linkSub(sub: SubWithList, node: SubNode): void {
  // Append to TAIL of subscriber.depsHead. Appending (vs prepending) keeps
  // recordDependency order aligned with dep-read order, which helps any
  // future position-based tracking and keeps cleanup traversal predictable.
  const oldTail = sub.depsTail ?? null;
  node.subPrev = oldTail;
  node.subNext = null;
  if (oldTail) oldTail.subNext = node;
  else sub.depsHead = node;
  sub.depsTail = node;
}

function unlinkSub(node: SubNode): void {
  const sub = node.sub as SubWithList | null;
  if (!sub) return;
  const prev = node.subPrev;
  const next = node.subNext;
  if (prev) prev.subNext = next;
  else sub.depsHead = next;
  if (next) next.subPrev = prev;
  else sub.depsTail = prev;
}

// ---------- Module state --------------------------------------------------

// `currentSubscriber` is the single source of truth for "who is reading?".
// track() and retrack() save/restore it around the body via a local prev;
// suspendTracking() captures it into `suspendSavedSub` and restores on resume.
// No stack is needed — nested tracking runs each keep their own local prev.
let currentSubscriber: Subscriber | null = null;
// Captured by suspendTracking at entry (when suspendDepth transitions 0→1);
// restored by the matching resumeTracking. Nested suspends just bump depth.
let suspendSavedSub: Subscriber | null = null;

// Notification queue for cascading propagation with deduplication.
let notifyDepth = 0;
const pendingQueue: Subscriber[] = [];
const pendingSet = new Set<Subscriber>();

// Reusable worklist for iterative propagateDirty.
const propagateStack: ReactiveSignal[] = [];

// Subscribers carry a `depsHead` / `depsTail` pair plus epoch/cycle fields.
// Kept as a typed alias for readability — at runtime a Subscriber is just
// a plain function, we attach these as untyped props.
type SubWithList = Subscriber & {
  depsHead?: SubNode | null;
  depsTail?: SubNode | null;
  _epoch?: number;
  _structDirty?: boolean;
  _runEpoch?: number;
  _runs?: number;
  _c?: number;
  _sig?: ReactiveSignal;
  __name?: string;
  // True when at least one dependency recorded during the most recent run was
  // a COMPUTED. Rebuilt from scratch by every `retrack`.
  //
  // WHY: the stabilization check only has something to prove when a computed is
  // involved. A subscriber is enqueued only by a source that actually changed
  // value — plain `signal()` setters bump `__v` and notify solely on a non-equal
  // write — so for a subscriber reading only plain signals the check can never
  // suppress the run, and walking its dep list is pure overhead on the hottest
  // path in the engine. Only a dirty computed can turn out to be unchanged.
  _hasComputedDep?: boolean;
  // Cached disposer returned by track() — allocated once on first track(),
  // reused for the life of the subscriber. Avoids per-invocation closure
  // allocation in hot paths (Wide Graph sink: 10k+ calls, Memory benchmark:
  // 25k+ effect creations).
  _dispose?: () => void;
};

// ---------- Safe invoke ---------------------------------------------------

function safeInvoke(sub: Subscriber): void {
  try {
    sub();
  } catch (err) {
    // Contain, but do not silence. Aborting the drain here would let one broken
    // component freeze every unrelated binding on the page; swallowing it (the
    // previous behaviour outside dev builds) made an application exception
    // indistinguishable from success in production. See ../core/errors.ts.
    reportError(err, { phase: "effect", name: (sub as SubWithList).__name });
  }
}

// ---------- Value-change validation --------------------------------------
//
// INVALIDATION IS NOT NOTIFICATION.
//
// `propagateDirty` runs at WRITE time and cannot know whether a computed's
// output actually changed — deciding that would require recomputing every
// computed eagerly, which is exactly the lazy-evaluation property the engine
// is built around. So it over-approximates: it dirties computeds and enqueues
// every downstream effect.
//
// This function is the compensating step, run at DRAIN time, immediately
// before a subscriber would execute. It settles any dirty computed the
// subscriber depends on (pull-based, so laziness is preserved: nothing is
// recomputed unless an effect is actually about to observe it) and compares
// each dependency's version against the version the subscriber last observed.
// If no dependency's VALUE changed, the subscriber does not run — which is
// what makes `derived({ equals })` stop propagation rather than merely
// deduplicate it.
//
// Conservative in every uncertain case: no tracked deps, a freed edge, an
// unversioned source (`__v === undefined` → stamped NaN → never equal), or a
// computed whose recompute threw all report "changed" so the subscriber runs
// and the error surfaces at its normal site.
// ---------------------------------------------------------------------------
function depsChanged(sub: SubWithList): boolean {
  let node = sub.depsHead ?? null;
  // A subscriber with no tracked dependencies cannot prove it is stable.
  if (node === null) return true;

  while (node !== null) {
    const sig = node.sig as SignalWithList | null;
    if (sig === null) return true;

    // A dirty computed's version is meaningless until it has recomputed.
    // Settling it here is what allows equality to stop propagation.
    if (sig._d === true && sig._validate !== undefined) {
      try {
        sig._validate();
      } catch {
        // Let the subscriber run so the failure surfaces where the user
        // expects it, rather than being attributed to the scheduler.
        return true;
      }
    }

    if (node.depVersion !== sig.__v) return true;
    node = node.subNext;
  }

  return false;
}

// ---------- Tracking suspension -------------------------------------------

let suspendDepth = 0;
let trackingSuspended = false;

export function suspendTracking(): void {
  if (suspendDepth === 0) {
    // Capture the ACTUAL current subscriber (not null). Resume restores
    // to this, so `untracked()` inside a tracking context returns control
    // to that context with the right subscriber, without needing a stack.
    suspendSavedSub = currentSubscriber;
    currentSubscriber = null;
    trackingSuspended = true;
  }
  suspendDepth++;
}

export function resumeTracking(): void {
  suspendDepth--;
  if (suspendDepth === 0) {
    currentSubscriber = suspendSavedSub;
    suspendSavedSub = null;
    trackingSuspended = false;
  }
}

/** Read the "tracking suspended" flag (used by derived's lazy path). */
export function isTrackingSuspended(): boolean {
  return trackingSuspended;
}

export function untracked<T>(fn: () => T): T {
  suspendTracking();
  try {
    return fn();
  } finally {
    resumeTracking();
  }
}

// ---------- Epoch counter for retrack-based pruning -----------------------

let subscriberEpochCounter = 0;

// ---------- retrack -------------------------------------------------------
//
// Re-run a subscriber body. Stable deps have their epoch stamp refreshed;
// deps that are no longer read are pruned at the end. Used by `derived()`
// to validate / recompute without paying the full Set.delete + re-add cycle
// of `track()`'s cleanup phase.
// ---------------------------------------------------------------------------
export function retrack(effectFn: () => void, subscriber: Subscriber): void {
  const prev = currentSubscriber;
  currentSubscriber = subscriber;
  const sub = subscriber as SubWithList;
  const epoch = ++subscriberEpochCounter;
  sub._epoch = epoch;
  sub._structDirty = false;
  // NOTE: `_hasComputedDep` is deliberately NOT cleared here. It is sticky, so
  // that `recordDependency` only has to test for a computed when an edge is
  // created rather than on every re-read of an existing one. A subscriber that
  // stops depending on any computed keeps the flag and pays for one redundant
  // (and still correct) validation walk per run — the safe direction.

  // Pre-walk: activate every existing dep on its signal so in-body
  // recordDependency hits can refresh the existing edge in O(1) via
  // `signal.__activeNode === existingNode && existingNode.sub === sub`.
  // Each node stashes the prior `__activeNode` value in `prevActive` so
  // outer tracking contexts' markers can be restored at post-walk.
  for (let n: SubNode | null = sub.depsHead ?? null; n !== null; n = n.subNext) {
    const sig = n.sig as SignalWithList;
    n.prevActive = sig.__activeNode ?? null;
    sig.__activeNode = n;
  }

  try {
    effectFn();
  } finally {
    currentSubscriber = prev;
    // Combined post-walk + stale-prune. For each node: restore the signal's
    // `__activeNode` to whatever outer tracking context had, then drop the
    // node if it wasn't refreshed during this run.
    let node = sub.depsHead ?? null;
    while (node !== null) {
      const next: SubNode | null = node.subNext;
      const sig = node.sig as SignalWithList;
      sig.__activeNode = node.prevActive;
      node.prevActive = null;
      if (node.epoch !== epoch) {
        unlinkSub(node);
        unlinkSignal(node);
        freeNode(node);
      }
      node = next;
    }
  }
}

// ---------- track ---------------------------------------------------------
//
// Full-cleanup + re-run. Used by effects (and one-shot initial setup of
// computeds). Returns a disposer that clears all remaining subs.
//
// Stack-free: saves `currentSubscriber` in a local and restores it in
// `finally`. Nested tracking runs each keep their own local prev; the old
// `subscriberStack` was only ever needed because `suspend/resumeTracking`
// used to push/pop null markers through it. suspend/resume now capture
// the current subscriber directly, so no shared stack is needed.
// ---------------------------------------------------------------------------
export function track(effectFn: () => void, subscriber?: Subscriber): () => void {
  // No explicit subscriber → this is an eagerly-re-running reactive binding
  // (the common `track(commit)` form used by class/style getters, directives,
  // router views, `watch`, `each`, etc.). Route it through `reactiveBinding`
  // so every re-run re-tracks dependencies. Using the body itself as the
  // subscriber (the old behavior) meant re-runs were invoked WITHOUT a tracking
  // context, so signals first read on a later run were never subscribed — the
  // per-run-tracking correctness bug. An EXPLICIT subscriber (e.g. `derived`'s
  // `markDirty`) keeps the run-once semantics below; such callers drive their
  // own re-evaluation via `retrack`.
  if (!subscriber) return reactiveBinding(effectFn);
  cleanup(subscriber);

  const prev = currentSubscriber;
  currentSubscriber = subscriber;

  try {
    effectFn();
  } finally {
    currentSubscriber = prev;

    // Post-walk: restore each signal's `__activeNode` to what outer
    // tracking contexts had before this track() started. We never do a
    // pre-walk here because cleanup() emptied the dep list up-front.
    const sub = subscriber as SubWithList;
    for (let n: SubNode | null = sub.depsHead ?? null; n !== null; n = n.subNext) {
      const sig = n.sig as SignalWithList;
      sig.__activeNode = n.prevActive;
      n.prevActive = null;
    }
  }

  // Cache the disposer on the subscriber so repeated track() calls (effects
  // re-running, derived re-setup) don't each allocate a fresh `() => cleanup`
  // closure. For a 10k-subscriber workload this eliminates 10k allocations.
  const sub = subscriber as SubWithList;
  return sub._dispose ?? (sub._dispose = () => cleanup(subscriber));
}

// ---------- reactiveBinding ------------------------------------------------
//
// Eagerly re-running reactive binding used by the DOM binding paths
// (bindChildNode / bindTextNode / bindAttribute). The subtlety it fixes:
//
//   A bare `track(commit)` registers `commit` ITSELF as the subscriber. On the
//   first run `commit` records its deps, but when a signal later notifies, the
//   drain invokes `commit()` DIRECTLY — with no `currentSubscriber` set and no
//   epoch reset. So `recordDependency` is a no-op on every re-run: deps read
//   for the FIRST time on a later run are never subscribed, and deps no longer
//   read are never pruned. The binding is reactive only to whatever it read on
//   its very first evaluation.
//
// The fix mirrors `effect()` / `derived()`: register a self-retracking
// subscriber. Every notification re-runs `commit` through `retrack`, which
// re-establishes the dependency set per run — adding newly-read deps and
// pruning stale ones. Returns a disposer that tears down all edges.
//
// The `_reentrant` guard makes every `retrack` of a given subscriber mutually
// exclusive. It is REQUIRED for correctness, not just loop safety: a `commit`
// that writes to one of its own deps mid-run (e.g. ErrorBoundary's content
// getter calls `setError` when a child render throws) would otherwise trigger
// the drain to re-invoke the subscriber synchronously, nesting a second
// `retrack` inside the first. The nested run bumps shared dep edges to a newer
// epoch, and the OUTER run's post-walk then prunes those edges as "stale" —
// silently dropping live subscriptions. Skipping the synchronous re-entry
// keeps the epoch bookkeeping single-threaded; the write still re-enqueues the
// subscriber, so the drain re-runs it once the outer run unwinds (eventual
// consistency, bounded by the drain's `tickRepeat` cap).
//
// The guard wraps BOTH the initial run and every notification-driven run.
// ---------------------------------------------------------------------------
export function reactiveBinding(commit: () => void): () => void {
  const run = (): void => {
    const s = subscriber as SubWithList & { _reentrant?: boolean; _disposed?: boolean };
    // A binding can be queued for notification and then disposed before the
    // drain reaches it (e.g. an enclosing when/each row is removed mid-drain).
    // Without this guard, re-running would re-read its signals and RE-SUBSCRIBE
    // the just-cleaned-up edges — a zombie binding that fires forever. Mirrors
    // the effect `disposed` guard so "dispose" reliably means "stop".
    if (s._disposed || s._reentrant) return;
    s._reentrant = true;
    try {
      retrack(commit, subscriber);
    } finally {
      s._reentrant = false;
    }
  };
  const subscriber = run as SubWithList & { _reentrant?: boolean; _disposed?: boolean };

  // Pre-initialize every field the core touches so all binding subscribers
  // share one hidden class (monomorphic inline caches in retrack / cleanup).
  subscriber.depsHead = null;
  subscriber.depsTail = null;
  subscriber._epoch = 0;
  subscriber._structDirty = false;
  subscriber._hasComputedDep = false;
  subscriber._runEpoch = 0;
  subscriber._runs = 0;
  subscriber._reentrant = false;
  subscriber._disposed = false;

  // Initial run establishes the first dependency set (guarded, see above).
  run();

  return (
    subscriber._dispose ??
    (subscriber._dispose = () => {
      (subscriber as { _disposed?: boolean })._disposed = true;
      cleanup(subscriber);
    })
  );
}

// ---------- recordDependency ----------------------------------------------
//
// Called for every signal read inside a tracking context. O(1) in all cases
// via the `signal.__activeNode` back-pointer:
//
//   * Pre-walk (retrack) or recordDependency-at-first-read (track) sets
//     `signal.__activeNode` to the edge for the current subscriber.
//   * Subsequent reads see `__activeNode.sub === currentSubscriber` and
//     refresh epoch in place — no linked-list walk.
//
// This is Preact Signals' approach. Without it, a subscriber with N deps
// (e.g. a sink effect in a wide fan-out graph) pays O(N²) per track run.
// ---------------------------------------------------------------------------
export function recordDependency(signal: ReactiveSignal) {
  if (!currentSubscriber) return;

  const sub = currentSubscriber as SubWithList;
  const sig = signal as SignalWithList;
  const epoch = sub._epoch ?? 0;

  // Stamp the version the subscriber is observing RIGHT NOW. `depsChanged`
  // compares against this before re-running the subscriber, so it must be the
  // version of the value actually being returned to the caller — `derived()`
  // therefore settles its value and bumps `__v` BEFORE calling us.
  // `?? Number.NaN` marks an unversioned source as permanently "changed".
  // O(1) dup check: if the signal's active edge already points at us,
  // it's a re-read within this run (or the first touch of an edge that
  // survived from the previous run). Refresh the epoch and version stamp.
  //
  // This is the hottest branch in the engine — a wide fan-in re-reads hundreds
  // of stable edges per run — so it does the minimum: no computed-detection
  // check, which the new-edge path below handles instead.
  const active = sig.__activeNode ?? null;
  if (active !== null && active.sub === sub) {
    active.epoch = epoch;
    active.depVersion = sig.__v ?? Number.NaN;
    return;
  }

  // Only a computed can be dirty-but-unchanged, so only a computed makes the
  // drain's stabilization check worth running for this subscriber. A computed
  // dependency can only ENTER the dep set here, and the flag is sticky (a
  // subscriber that later drops the computed merely pays for one redundant
  // walk, which is safe), so the check belongs on this cold path rather than on
  // every re-read above.
  if (sig._validate !== undefined) sub._hasComputedDep = true;

  // New edge. Stash whatever `__activeNode` was (may be null, may be an
  // outer tracking context's node) into `prevActive` so the post-walk
  // restores it.
  const node = allocNode(signal, sub, epoch);
  node.depVersion = sig.__v ?? Number.NaN;
  node.prevActive = active;
  sig.__activeNode = node;
  linkSub(sub, node);
  linkSignal(sig, node);
  sub._structDirty = true;
}

// ---------- cleanup --------------------------------------------------------
//
// Tear down every edge attached to this subscriber. Called by track() before
// re-running and by the dispose handle. Nodes are returned to the pool.
//
// Exported so callers can dispose a subscriber without track() having to
// allocate a per-call closure `() => cleanup(sub)`. Effect.ts calls this
// directly on dispose, eliminating ~1 closure allocation per track() call.
// ---------------------------------------------------------------------------
export function cleanup(subscriber: Subscriber): void {
  const sub = subscriber as SubWithList;
  let node = sub.depsHead ?? null;
  // We clear the subscriber's head/tail up-front so we don't have to
  // repeatedly adjust them while unlinking — each node still needs its own
  // signal-side unlink to maintain the signal's list invariant.
  sub.depsHead = null;
  sub.depsTail = null;
  while (node) {
    const next = node.subNext;
    unlinkSignal(node);
    freeNode(node);
    node = next;
  }
}

// ---------- Cycle detection -----------------------------------------------
//
// Per-subscriber repeat count within a single drain. A subscriber that fires
// more than `maxSubscriberRepeats` times in one drain is almost certainly a
// write-reads-self cycle — bail loudly instead of wasting cycles. Counts
// live on the subscriber itself via an epoch to avoid end-of-drain walks.
// ---------------------------------------------------------------------------
// A subscriber that fires more than this many times in ONE drain is treated as
// a write-reads-self cycle.
//
// WHY 1000 AND NOT A TIGHTER BOUND: this is a cycle heuristic, and the only
// thing separating "cycle" from "legitimate deep cascade" is how many times a
// subscriber legitimately re-runs. A fan-in subscriber observing an N-link
// cascade re-runs N times — entirely finite and correct. The previous ceiling
// of 50 misclassified such graphs as cycles and, worse, aborted the whole
// drain, so a 60-link cascade terminated half-propagated with WRONG values in
// the un-drained tail. A genuine infinite cycle still terminates here in
// microseconds; a legitimate graph deeper than this is vanishingly rare, and
// `maxDrainIterations` remains the absolute backstop.
let maxSubscriberRepeats = 1000;
let maxDrainIterations = 1_000_000;
let drainEpoch = 0;

// Subscribers that tripped the repeat ceiling during the CURRENT drain.
// They are skipped for the remainder of the drain instead of aborting it —
// see `drainQueue`. Cleared when the outermost drain completes.
const quarantined = new Set<Subscriber>();

export function setMaxSubscriberRepeats(n: number): number {
  const prev = maxSubscriberRepeats;
  if (Number.isFinite(n) && n > 0) maxSubscriberRepeats = Math.floor(n);
  return prev;
}

export function setMaxDrainIterations(n: number): number {
  const prev = maxDrainIterations;
  if (Number.isFinite(n) && n > 0) maxDrainIterations = Math.floor(n);
  return prev;
}

function tickRepeat(sub: Subscriber): boolean {
  const s = sub as SubWithList;
  if (s._runEpoch !== drainEpoch) {
    s._runEpoch = drainEpoch;
    s._runs = 1;
    return false;
  }
  s._runs = (s._runs ?? 0) + 1;
  return s._runs > maxSubscriberRepeats;
}

function cycleError(sub: Subscriber): void {
  const name = (sub as SubWithList).__name ?? "<unnamed>";
  reportError(
    new Error(
      `subscriber "${name}" fired more than ${maxSubscriberRepeats} times — ` +
        "likely a write-reads-self cycle between effects/signals. This subscriber is " +
        "quarantined for the rest of this update; other pending work still runs.",
    ),
    { phase: "scheduler", name },
  );
}

function absoluteDrainError(): void {
  reportError(
    new Error(
      `Notification drain exceeded ${maxDrainIterations} iterations — ` +
        "absolute safety net tripped. Breaking to prevent infinite loop.",
    ),
    { phase: "scheduler" },
  );
}

// ---------- Drain ---------------------------------------------------------

function drainQueue(): void {
  let i = 0;
  while (i < pendingQueue.length) {
    if (i >= maxDrainIterations) {
      absoluteDrainError();
      break;
    }
    const sub = pendingQueue[i++];
    // Remove from pendingSet BEFORE invoking so a cascading write during
    // this sub's execution can re-enqueue it. Enables sibling-effect
    // convergence; tickRepeat caps runaway loops.
    pendingSet.delete(sub);

    // An offender identified earlier in THIS drain stays parked. Skipping only
    // the offender is what breaks the cycle — a quarantined subscriber stops
    // writing, so its partner stops being re-enqueued.
    if (quarantined.size > 0 && quarantined.has(sub)) continue;

    // Stabilization gate: an upstream source changing does not mean this
    // subscriber's observable inputs changed. Checked BEFORE tickRepeat so a
    // suppressed run never counts toward the cycle ceiling.
    //
    // Skipped entirely for subscribers with no computed dependency: they were
    // enqueued by a source that provably changed value, so the walk could only
    // ever return true. This keeps the plain-signal hot path allocation- and
    // traversal-free, which is what the un-batched update workload exercises.
    if ((sub as SubWithList)._hasComputedDep === true && !depsChanged(sub as SubWithList)) continue;

    if (tickRepeat(sub)) {
      cycleError(sub);
      // Quarantine the offender and KEEP DRAINING. Aborting the whole queue
      // here let one pathological subscriber discard unrelated, already-valid
      // pending work — leaving legitimate effects un-run and application state
      // half-updated. Containment must be scoped to the offender.
      quarantined.add(sub);
      continue;
    }

    safeInvoke(sub);
  }
}

export function drainNotificationQueue(): void {
  if (notifyDepth > 0) return;
  notifyDepth++;
  drainEpoch++;
  try {
    drainQueue();
  } finally {
    notifyDepth--;
    if (notifyDepth === 0) {
      pendingQueue.length = 0;
      pendingSet.clear();
      // Quarantine is scoped to a single drain: a cycle broken here should not
      // permanently disable the subscriber for later, unrelated transactions.
      if (quarantined.size > 0) quarantined.clear();
    }
  }
}

// ---------- propagateDirty ------------------------------------------------
//
// Walks downstream from a changed signal, marking computed subscribers dirty
// and enqueuing effect subscribers. Iterative via a module-level worklist so
// deep chains (1000+ levels) don't consume the JS call stack.
// ---------------------------------------------------------------------------
function propagateDirty(sub: Subscriber): void {
  sub(); // markDirty: sets the computed's _d flag
  const rootSig: ReactiveSignal | undefined = (sub as SubWithList)._sig;
  if (!rootSig) return;

  const stack = propagateStack;
  const baseLen = stack.length;
  stack.push(rootSig);

  while (stack.length > baseLen) {
    const sig = stack.pop() as SignalWithList;
    let node = sig.subsHead ?? null;
    while (node) {
      const s = node.sub as SubWithList | null;
      // node.sub is null only inside freeNode — shouldn't happen mid-walk,
      // but the guard keeps us safe against a freed-but-still-linked corner
      // case during a throwing effect body.
      if (s) {
        if (s._c) {
          const nSig = s._sig as (SignalWithList & { _d?: boolean }) | undefined;
          if (nSig) {
            // Avoid redundant downstream walks when the same signal is
            // reached by multiple diamond paths — mark dirty inline and
            // only push the signal if it wasn't already dirty.
            if (!nSig._d) {
              nSig._d = true;
              stack.push(nSig);
            }
            // Defensive: every `_c` (computed) subscriber carries a `_sig`
            // (set in derived()), so this fallback is unreachable in practice.
            /* v8 ignore next 3 */
          } else {
            s();
          }
        } else if (!pendingSet.has(s)) {
          pendingSet.add(s);
          pendingQueue.push(s);
        }
      }
      node = node.sigNext;
    }
  }
}

// ---------- Public notification entrypoints ------------------------------

export function queueSignalNotification(signal: ReactiveSignal): void {
  const sig = signal as SignalWithList;
  let node = sig.subsHead ?? null;
  while (node) {
    const s = node.sub as SubWithList | null;
    if (s) {
      if (s._c) {
        propagateDirty(s);
      } else if (!pendingSet.has(s)) {
        pendingSet.add(s);
        pendingQueue.push(s);
      }
    }
    node = node.sigNext;
  }
}

export function notifySubscribers(signal: ReactiveSignal) {
  const sig = signal as SignalWithList;
  const head = sig.subsHead;
  if (!head) return;

  if (notifyDepth > 0) {
    // Cascading: enqueue everything with dedup.
    let node: SubNode | null = head;
    while (node) {
      const s = node.sub as SubWithList | null;
      if (s) {
        if (s._c) {
          propagateDirty(s);
        } else if (!pendingSet.has(s)) {
          pendingSet.add(s);
          pendingQueue.push(s);
        }
      }
      node = node.sigNext;
    }
    return;
  }

  // Outermost notification: snapshot direct subs into the queue, then drain.
  // Using the existing pendingQueue/pendingSet keeps the drain semantics
  // (eventual-consistency via pre-invoke pendingSet.delete) identical to the
  // Set-based implementation.
  notifyDepth++;
  drainEpoch++;
  try {
    let node: SubNode | null = head;
    while (node) {
      const s = node.sub as SubWithList | null;
      if (s) {
        if (s._c) {
          propagateDirty(s);
        } else if (!pendingSet.has(s)) {
          pendingSet.add(s);
          pendingQueue.push(s);
        }
      }
      node = node.sigNext;
    }
    drainQueue();
  } finally {
    notifyDepth--;
    if (notifyDepth === 0) {
      pendingQueue.length = 0;
      pendingSet.clear();
      // Quarantine is scoped to a single drain: a cycle broken here should not
      // permanently disable the subscriber for later, unrelated transactions.
      if (quarantined.size > 0) quarantined.clear();
    }
  }
}

// ---------- Devtools helpers ----------------------------------------------

/** O(1) subscriber count for devtools / introspection. */
export function getSubscriberCount(signal: ReactiveSignal): number {
  return (signal as SignalWithList).__sc ?? 0;
}

/** Return the signals a subscriber currently depends on, in record order. */
export function getSubscriberDeps(subscriber: Subscriber): ReactiveSignal[] {
  const sub = subscriber as SubWithList;
  const out: ReactiveSignal[] = [];
  let node = sub.depsHead ?? null;
  while (node) {
    if (node.sig) out.push(node.sig);
    node = node.subNext;
  }
  return out;
}

/** Iterate subscribers of a signal (devtools graph walk). */
export function forEachSubscriber(signal: ReactiveSignal, visit: (sub: Subscriber) => void): void {
  let node = (signal as SignalWithList).subsHead ?? null;
  while (node) {
    const s = node.sub;
    if (s) visit(s);
    node = node.sigNext;
  }
}
