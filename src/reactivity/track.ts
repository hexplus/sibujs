import { devWarn, isDev } from "../core/dev";
import type { ReactiveSignal } from "./signal";

type Subscriber = () => void;

// Cache dev mode at module load for zero-cost production checks
const _isDev = isDev();

// Stack to support nested subscribers — pre-allocated with index for O(1) push/pop.
// Grows by doubling on overflow; lazily shrinks at end-of-track() when idle so a
// one-off spike in nesting depth doesn't permanently retain the memory.
const STACK_INITIAL = 32;
const STACK_SHRINK_THRESHOLD = 128; // only attempt shrink when capacity exceeds this
const subscriberStack: (Subscriber | null)[] = new Array(STACK_INITIAL);
let stackCapacity = STACK_INITIAL;
let stackTop = -1;
let currentSubscriber: Subscriber | null = null;

// Subscriber deps stored directly on subscriber as _deps property (avoids WeakMap).
// Signal subscribers stored in Set cached on signal as __s (avoids WeakMap in hot path).

// Fast notification cache: store the Set reference directly on the signal
// for O(1) property access during notification (avoids WeakMap hash lookup).
// The cached Set is the SAME object stored in signalSubscribers.
const SUBS = "__s" as const;
type SignalWithCache = ReactiveSignal & { [SUBS]?: Set<Subscriber>; __f?: Subscriber };

// ---------------------------------------------------------------------------
// Fast-path (__f / __s) invariant — maintained by syncFastPath() below:
//
//   subs.size === 0  →  __f = undefined, __s deleted (zero-allocation signal)
//   subs.size === 1  →  __f = the single subscriber
//   subs.size >= 2   →  __f = undefined
//
// All add/remove operations must call syncFastPath() after mutating the set
// so no code path leaves these out of sync. Inlined in the hot paths for
// zero-overhead: the function itself exists for correctness & readability.
// ---------------------------------------------------------------------------
function syncFastPath(signal: SignalWithCache, subs: Set<Subscriber>): void {
  const size = subs.size;
  if (size === 0) {
    signal.__f = undefined;
    delete signal[SUBS];
  } else if (size === 1) {
    signal.__f = subs.values().next().value;
  } else {
    signal.__f = undefined;
  }
}

// Notification queue for cascading propagation with deduplication.
let notifyDepth = 0;
const pendingQueue: Subscriber[] = [];
const pendingSet = new Set<Subscriber>();

// Reusable worklist for iterative propagateDirty — avoids recursion on
// wide diamonds where a single signal fans out to many computeds each
// with their own downstream chains.
const propagateStack: ReactiveSignal[] = [];

/**
 * Safely invoke a subscriber, catching errors to prevent one failing
 * subscriber from killing remaining subscribers in the notification queue.
 */
function safeInvoke(sub: Subscriber): void {
  try {
    sub();
  } catch (err) {
    if (_isDev) devWarn(`Subscriber threw during notification: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Suspend/resume tracking: counter-based for nested computed evaluations.
let suspendDepth = 0;
export let trackingSuspended = false;

// ---------------------------------------------------------------------------
// Subscriber epoch counter for retrack-based stale-dep pruning.
//
// Each call to `retrack()` bumps this counter and stamps the subscriber's
// `_epoch` with the new value. recordDependency() tags each accessed dep
// with the subscriber's current epoch. At end of retrack(), any dep whose
// tagged epoch is not the current one was NOT read during this evaluation
// and is therefore stale — we unsubscribe it and remove the edge.
//
// This closes the stale-dep leak that otherwise accumulates on derived
// getters with conditional branches (e.g. `() => flag() ? a() : b()`):
// without pruning, both `a` and `b` stay subscribed forever even though
// only one is read per evaluation, causing unnecessary re-evaluations.
// ---------------------------------------------------------------------------
let subscriberEpochCounter = 0;

/**
 * Re-run a subscriber body. Stale deps (present before but not re-read
 * during this run) are pruned at end via epoch comparison — fixes the
 * conditional-derived over-subscription problem without paying the
 * full Set.delete + re-subscribe cost of `track()`'s cleanup phase.
 *
 * Used by `derived` on every pull. Uses a simple save/restore of
 * `currentSubscriber` instead of the stackTop push/pop — measurably
 * faster on deep chains where this function runs per-level.
 */
export function retrack(effectFn: () => void, subscriber: Subscriber): void {
  const prev = currentSubscriber;
  currentSubscriber = subscriber;
  const sub = subscriber as any;
  const epoch = ++subscriberEpochCounter;
  sub._epoch = epoch;
  try {
    effectFn();
  } finally {
    currentSubscriber = prev;
    pruneStaleDeps(sub, epoch);
  }
}

/**
 * Unsubscribe from any deps recorded with an epoch other than `currentEpoch`
 * (i.e. deps that were not re-read during the most recent retrack).
 */
function pruneStaleDeps(sub: any, currentEpoch: number): void {
  // Single-dep fast path
  if (sub._dep !== undefined) {
    if (sub._depEpoch !== currentEpoch) {
      const sig = sub._dep as SignalWithCache;
      const subs = sig[SUBS];
      if (subs?.delete(sub)) syncFastPath(sig, subs);
      sub._dep = undefined;
      sub._depEpoch = undefined;
    }
    return;
  }

  // Multi-dep path — _deps is Map<signal, epoch>
  const deps: Map<ReactiveSignal, number> | undefined = sub._deps;
  if (!deps || deps.size === 0) return;

  // Collect stales in one pass, mutate in a second — avoids iterating a Map
  // while deleting entries on most engines.
  let stales: ReactiveSignal[] | undefined;
  for (const [signal, epoch] of deps) {
    if (epoch !== currentEpoch) {
      (stales ??= []).push(signal);
    }
  }
  if (!stales) return;
  for (const signal of stales) {
    deps.delete(signal);
    const sig = signal as SignalWithCache;
    const subs = sig[SUBS];
    if (subs?.delete(sub)) syncFastPath(sig, subs);
  }
}

/**
 * Track dependencies of an effect or computed subscriber.
 * Returns a teardown function to remove all subscriptions.
 */
export function track(effectFn: () => void, subscriber?: Subscriber): () => void {
  if (!subscriber) subscriber = effectFn;
  cleanup(subscriber);

  ++stackTop;
  if (stackTop >= stackCapacity) {
    stackCapacity *= 2;
    subscriberStack.length = stackCapacity;
  }
  subscriberStack[stackTop] = subscriber;
  currentSubscriber = subscriber;

  try {
    effectFn();
  } finally {
    stackTop--;
    currentSubscriber = stackTop >= 0 ? subscriberStack[stackTop] : null;
    // Lazy shrink: if the stack is idle and grew well beyond typical usage,
    // halve the underlying array so a transient deep-nesting spike doesn't
    // retain memory for the process lifetime. One extra branch on the cold
    // exit path; no effect on the hot path.
    if (stackTop < 0 && stackCapacity > STACK_SHRINK_THRESHOLD) {
      stackCapacity = Math.max(STACK_INITIAL, stackCapacity >>> 1);
      subscriberStack.length = stackCapacity;
    }
  }

  return () => cleanup(subscriber);
}

/**
 * Suspend dependency tracking. Used by lazy computed re-evaluation.
 */
export function suspendTracking(): void {
  if (suspendDepth === 0) {
    ++stackTop;
    if (stackTop >= stackCapacity) {
      stackCapacity *= 2;
      subscriberStack.length = stackCapacity;
    }
    subscriberStack[stackTop] = null;
    currentSubscriber = null;
    trackingSuspended = true;
  }
  suspendDepth++;
}

/**
 * Resume dependency tracking after suspendTracking().
 */
export function resumeTracking(): void {
  suspendDepth--;
  if (suspendDepth === 0) {
    stackTop--;
    currentSubscriber = stackTop >= 0 ? subscriberStack[stackTop] : null;
    trackingSuspended = false;
  }
}

/**
 * Execute a function without tracking any signal reads as dependencies.
 * Useful for reading signals inside effects without creating subscriptions.
 *
 * @param fn Function to execute without dependency tracking
 * @returns The return value of fn
 */
export function untracked<T>(fn: () => T): T {
  suspendTracking();
  try {
    return fn();
  } finally {
    resumeTracking();
  }
}

/**
 * Record that the current subscriber depends on this signal.
 *
 * Fast path: for the first dependency of a subscriber, stores the signal
 * directly as _dep (avoiding Map allocation). Promotes to _deps Map only
 * when a second dependency is recorded. Most effects/computeds have 1-3 deps,
 * so the single-dep fast path eliminates Map overhead in the common case.
 *
 * Every edge is tagged with the subscriber's current `_epoch` so that
 * `retrack()` can identify and prune stale deps at end of evaluation.
 * Subscribers that only ever flow through `track()` (effects) don't set
 * _epoch; the epoch field is then `undefined` and harmlessly unused.
 */
export function recordDependency(signal: ReactiveSignal) {
  if (!currentSubscriber) return;

  const sub = currentSubscriber as any;
  const epoch = sub._epoch;

  // Fast path: check single-dep slot first. Still refresh epoch so
  // pruneStaleDeps sees this dep as "live" during retrack.
  if (sub._dep === signal) {
    sub._depEpoch = epoch;
    return;
  }

  const deps: Map<ReactiveSignal, number> | undefined = sub._deps;
  if (deps) {
    // Map.set both adds new edges and refreshes the epoch on existing ones.
    // The subs.add() call below is idempotent, so it's safe to run
    // unconditionally — Set.add is fast enough that the "already subscribed"
    // short-circuit isn't worth the branch.
    deps.set(signal, epoch);
  } else if (sub._dep !== undefined) {
    // Promote single-dep to Map (carry forward the existing epoch).
    const map = new Map<ReactiveSignal, number>();
    map.set(sub._dep, sub._depEpoch);
    map.set(signal, epoch);
    sub._deps = map;
    sub._dep = undefined;
    sub._depEpoch = undefined;
  } else {
    // First dep — store directly, no Map allocation
    sub._dep = signal;
    sub._depEpoch = epoch;
  }

  // Register subscriber on the signal. subs.add() is idempotent: if the
  // subscriber was already subscribed (stable dep during retrack), size
  // won't change and syncFastPath stays a no-op.
  const sig = signal as SignalWithCache;
  let subs = sig[SUBS];
  if (!subs) {
    subs = new Set();
    sig[SUBS] = subs;
  }
  const prevSize = subs.size;
  subs.add(currentSubscriber);
  if (subs.size !== prevSize) {
    if (subs.size === 1) {
      sig.__f = currentSubscriber;
    } else if (sig.__f !== undefined) {
      sig.__f = undefined;
    }
  }
}

/**
 * Queue all subscribers of a signal for deferred notification.
 * Computed subscribers (_c) are propagated through the chain via propagateDirty
 * so their downstream effect subscribers get queued correctly.
 */
export function queueSignalNotification(signal: ReactiveSignal): void {
  const subs = (signal as SignalWithCache)[SUBS];
  if (!subs) return;
  for (const sub of subs) {
    if ((sub as any)._c) {
      propagateDirty(sub);
    } else if (!pendingSet.has(sub)) {
      pendingSet.add(sub);
      pendingQueue.push(sub);
    }
  }
}

/**
 * Cycle detection during notification drain.
 *
 * We no longer cap the total drain iterations (which conflates large
 * legitimate fan-out with real cycles). Instead, we count how many times
 * each individual subscriber has fired during the current drain. If any
 * single subscriber fires more than `maxSubscriberRepeats` times, that is
 * a near-certain sign of a write-reads-self cycle — bail loudly.
 *
 * Counts live on the subscriber itself (`_runs`, `_runEpoch`), reset lazily
 * via an epoch counter to avoid walking all subscribers at end-of-drain.
 *
 * `maxDrainIterations` is kept as an absolute belt-and-braces safety net;
 * it is sized high enough that legitimate apps (100k+ subscribers) never
 * hit it, while still preventing a runaway process from eating all memory.
 */
let maxSubscriberRepeats = 50;
let maxDrainIterations = 1_000_000;
let drainEpoch = 0;

/** Raise/lower the per-subscriber repeat cap. Returns previous value. */
export function setMaxSubscriberRepeats(n: number): number {
  const prev = maxSubscriberRepeats;
  if (Number.isFinite(n) && n > 0) maxSubscriberRepeats = Math.floor(n);
  return prev;
}

/** Raise/lower the absolute drain iteration safety net. Returns previous value. */
export function setMaxDrainIterations(n: number): number {
  const prev = maxDrainIterations;
  if (Number.isFinite(n) && n > 0) maxDrainIterations = Math.floor(n);
  return prev;
}

/**
 * Record one invocation of `sub` in the current drain and return true iff
 * it has just exceeded the per-subscriber repeat cap (indicating a cycle).
 */
function tickRepeat(sub: Subscriber): boolean {
  const s = sub as any;
  if (s._runEpoch !== drainEpoch) {
    s._runEpoch = drainEpoch;
    s._runs = 1;
    return false;
  }
  return ++s._runs > maxSubscriberRepeats;
}

function cycleError(sub: Subscriber): void {
  if (typeof console !== "undefined") {
    const name = (sub as any).__name ?? "<unnamed>";
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

/**
 * Process pending subscriber notifications until the queue is empty.
 *
 * Convergence model:
 *   - A subscriber is removed from `pendingSet` immediately before invocation,
 *     so any cascading write during its execution can re-enqueue it. This
 *     allows sibling effects to converge on a consistent state when one
 *     effect writes a signal another effect reads.
 *   - `tickRepeat` bounds convergence: if a single subscriber fires more
 *     than `maxSubscriberRepeats` times, we bail — that's a true cycle.
 *   - `maxDrainIterations` is an absolute safety net for legitimate fan-out.
 */
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

/**
 * Iteratively propagate dirty flags through a computed chain.
 *
 * Marks each computed dirty and walks downstream subscribers via an explicit
 * worklist (no recursion). markDirty (tagged _c) sets the dirty flag; _sig
 * exposes the computed's signal for walking downstream. Does NOT eagerly
 * evaluate — computedGetter uses track() on re-evaluation to re-register
 * dependencies, which is essential for derived-of-derived chains (e.g.
 * formula cells referencing other formula cells).
 *
 * In the __f fast path (single-subscriber chains), sets _d directly on the
 * signal — avoids megamorphic function calls to markDirty. Multi-dep
 * computeds are marked dirty and pulled lazily to avoid O(n²) re-evaluation
 * when many deps update.
 */
function propagateDirty(sub: () => void): void {
  sub(); // markDirty: sets dirty flag
  const rootSig: ReactiveSignal | undefined = (sub as any)._sig;
  if (!rootSig) return;

  // Iterative worklist using a reusable module-level stack.
  // Each entry is a signal whose subscribers still need walking.
  const stack = propagateStack;
  const baseLen = stack.length;
  stack.push(rootSig);

  while (stack.length > baseLen) {
    const sig = stack.pop() as ReactiveSignal;

    // Fast path: single subscriber cached in __f
    const first: any = (sig as any).__f;
    if (first) {
      if (first._c) {
        const nSig: any = first._sig;
        // Skip if already dirty — avoids redundant downstream walks on
        // deep chains where the same signal is reached multiple times.
        if (!nSig._d) {
          nSig._d = true;
          stack.push(nSig);
        }
      } else if (!pendingSet.has(first)) {
        pendingSet.add(first);
        pendingQueue.push(first);
      }
      continue;
    }

    // Multi-subscriber path (Set iteration)
    const subs = (sig as SignalWithCache)[SUBS];
    if (!subs) continue;

    for (const s of subs) {
      if ((s as any)._c) {
        const nSig: any = (s as any)._sig;
        if (nSig && !nSig._d) {
          nSig._d = true; // markDirty inline; skip self-call when already dirty
          stack.push(nSig);
        } else if (!nSig) {
          s(); // computed without _sig — fall back to function call
        }
      } else if (!pendingSet.has(s)) {
        pendingSet.add(s);
        pendingQueue.push(s);
      }
    }
  }
}

/**
 * Notify all subscribers of a given signal change.
 *
 * Unified model:
 *   - For outermost notifications: enqueue all effect subs, propagate dirty
 *     through computed subs, then drain the queue. A subscriber is
 *     re-eligible for enqueue once it has begun executing (pendingSet is
 *     cleared of it before invoke), so sibling effects converge when one
 *     effect's write dirties a signal another effect reads.
 *   - Cycles bound: per-subscriber repeat counting (tickRepeat) stops
 *     runaway write-reads-self loops loudly rather than silently.
 *   - Single-subscriber fast path: when there is exactly one subscriber,
 *     inline invocation is safe — there is no sibling that could observe
 *     an intermediate state — and avoids queue allocation overhead.
 *
 * This replaces an older 3-pass structure whose fast/slow paths diverged
 * on whether effects could re-run during cascade: the fast path allowed it
 * (eventually consistent), the slow path did not (single-run-maybe-stale).
 * Unification makes both paths eventually consistent.
 */
export function notifySubscribers(signal: ReactiveSignal) {
  // Fast path: single subscriber (avoids Set iteration entirely)
  const first: any = (signal as any).__f;
  if (first) {
    if (notifyDepth > 0) {
      if (first._c) {
        propagateDirty(first);
      } else if (!pendingSet.has(first)) {
        pendingSet.add(first);
        pendingQueue.push(first);
      }
      return;
    }
    notifyDepth++;
    drainEpoch++;
    try {
      if (first._c) {
        propagateDirty(first);
      } else if (tickRepeat(first)) {
        cycleError(first);
      } else {
        safeInvoke(first);
      }
      drainQueue();
    } finally {
      notifyDepth--;
      if (notifyDepth === 0) {
        pendingQueue.length = 0;
        pendingSet.clear();
      }
    }
    return;
  }

  const subs = (signal as SignalWithCache)[SUBS];
  if (!subs || subs.size === 0) return;

  if (notifyDepth > 0) {
    // Cascading: computed subs propagated iteratively, effects queued with dedup
    for (const sub of subs) {
      if ((sub as any)._c) {
        propagateDirty(sub);
      } else if (!pendingSet.has(sub)) {
        pendingSet.add(sub);
        pendingQueue.push(sub);
      }
    }
    return;
  }

  // Outermost multi-subscriber notification.
  notifyDepth++;
  drainEpoch++;
  try {
    // Single iteration over direct subs:
    //   - computed subs → propagateDirty (marks downstream dirty, queues
    //     downstream effects via the notifyDepth>0 cascade branch above)
    //   - effect subs → enqueue with pendingSet dedup
    // Iteration order matches Set insertion order, so effects run in
    // subscription order during drain (modulo cascaded re-runs).
    for (const sub of subs) {
      if ((sub as any)._c) {
        propagateDirty(sub);
      } else if (!pendingSet.has(sub)) {
        pendingSet.add(sub);
        pendingQueue.push(sub);
      }
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

/**
 * Remove a subscriber from all signal dependency lists.
 *
 * After each removal, syncFastPath() restores the __f / __s invariant:
 * empty sets are cleared to release memory, and __f tracks the last
 * remaining subscriber when size collapses back to 1.
 */
function cleanup(subscriber: Subscriber) {
  const sub = subscriber as any;

  // Fast path: single dependency (no Map to iterate)
  const singleDep: ReactiveSignal | undefined = sub._dep;
  if (singleDep !== undefined) {
    const sig = singleDep as SignalWithCache;
    const subs = sig[SUBS];
    if (subs?.delete(subscriber)) {
      syncFastPath(sig, subs);
    }
    sub._dep = undefined;
    sub._depEpoch = undefined;
    return;
  }

  // Multi-dep path — _deps is Map<signal, epoch>
  const deps: Map<ReactiveSignal, number> | undefined = sub._deps;
  if (!deps || deps.size === 0) return;

  for (const signal of deps.keys()) {
    const sig = signal as SignalWithCache;
    const subs = sig[SUBS];
    if (subs?.delete(subscriber)) {
      syncFastPath(sig, subs);
    }
  }

  deps.clear();
}
