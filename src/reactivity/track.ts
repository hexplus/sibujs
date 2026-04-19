import { devWarn, isDev } from "../core/dev";
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
// ---------------------------------------------------------------------------

type Subscriber = () => void;

// Cache dev mode at module load for zero-cost production checks
const _isDev = isDev();

// ---------- Subscription edge ---------------------------------------------

interface SubNode {
  // The edge endpoints — null only while the node is sitting in the free pool.
  sig: ReactiveSignal | null;
  sub: Subscriber | null;
  // Epoch stamp refreshed on every recordDependency() call. `retrack()` uses
  // this to detect deps that were present before the run but not re-read.
  epoch: number;
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
    if (_isDev) devWarn(`Subscriber threw during notification: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------- Tracking suspension -------------------------------------------

let suspendDepth = 0;
export let trackingSuspended = false;

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
  if (!subscriber) subscriber = effectFn;
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

  // O(1) dup check: if the signal's active edge already points at us,
  // it's a re-read within this run. Refresh the epoch and we're done.
  const active = sig.__activeNode ?? null;
  if (active !== null && active.sub === sub) {
    active.epoch = epoch;
    return;
  }

  // New edge. Stash whatever `__activeNode` was (may be null, may be an
  // outer tracking context's node) into `prevActive` so the post-walk
  // restores it.
  const node = allocNode(signal, sub, epoch);
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
let maxSubscriberRepeats = 50;
let maxDrainIterations = 1_000_000;
let drainEpoch = 0;

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
  if (typeof console !== "undefined") {
    const name = (sub as SubWithList).__name ?? "<unnamed>";
    console.error(
      `[SibuJS] subscriber "${name}" fired more than ${maxSubscriberRepeats} times — ` +
        "likely a write-reads-self cycle between effects/signals. Breaking to prevent infinite loop.",
    );
  }
}

function absoluteDrainError(): void {
  if (typeof console !== "undefined") {
    console.error(
      `[SibuJS] Notification drain exceeded ${maxDrainIterations} iterations — ` +
        "absolute safety net tripped. Breaking to prevent infinite loop.",
    );
  }
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
    if (tickRepeat(sub)) {
      cycleError(sub);
      break;
    }
    // Remove from pendingSet BEFORE invoking so a cascading write during
    // this sub's execution can re-enqueue it. Enables sibling-effect
    // convergence; tickRepeat caps runaway loops.
    pendingSet.delete(sub);
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
