import { devWarn, isDev } from "../core/dev";
import type { ReactiveSignal } from "./signal";

type Subscriber = () => void;

// Cache dev mode at module load for zero-cost production checks
const _isDev = isDev();

// Stack to support nested subscribers — pre-allocated with index for O(1) push/pop
const subscriberStack: (Subscriber | null)[] = new Array(32);
let stackCapacity = 32;
let stackTop = -1;
let currentSubscriber: Subscriber | null = null;

// Subscriber deps stored directly on subscriber as _deps property (avoids WeakMap).
// Signal subscribers stored in Set cached on signal as __s (avoids WeakMap in hot path).

// Fast notification cache: store the Set reference directly on the signal
// for O(1) property access during notification (avoids WeakMap hash lookup).
// The cached Set is the SAME object stored in signalSubscribers.
const SUBS = "__s" as const;
type SignalWithCache = ReactiveSignal & { [SUBS]?: Set<Subscriber> };

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

/**
 * Re-run a subscriber body WITHOUT cleanup. New deps naturally subscribe via
 * recordDependency; previously-subscribed deps stay subscribed (accepting
 * mild over-subscription on conditional getters — same model as Vue/MobX/
 * Preact Signals).
 *
 * Used by `derived` on every pull. Skips the O(N) Set.delete + Set.add
 * cycle per dep that `track()`'s cleanup phase incurs, AND uses a simple
 * save/restore of `currentSubscriber` instead of the stackTop push/pop —
 * measurably faster on deep chains where this function runs per-level.
 */
export function retrack(effectFn: () => void, subscriber: Subscriber): void {
  const prev = currentSubscriber;
  currentSubscriber = subscriber;
  try {
    effectFn();
  } finally {
    currentSubscriber = prev;
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
 * directly as _dep (avoiding Set allocation). Promotes to _deps Set only
 * when a second dependency is recorded. Most effects/computeds have 1-3 deps,
 * so the single-dep fast path eliminates Set overhead in the common case.
 */
export function recordDependency(signal: ReactiveSignal) {
  if (!currentSubscriber) return;

  const sub = currentSubscriber as any;

  // Fast path: check single-dep slot first
  if (sub._dep === signal) return;

  const deps: Set<ReactiveSignal> | undefined = sub._deps;
  if (deps) {
    if (deps.has(signal)) return;
    deps.add(signal);
  } else if (sub._dep !== undefined) {
    // Promote single-dep to Set
    const set = new Set<ReactiveSignal>();
    set.add(sub._dep);
    set.add(signal);
    sub._deps = set;
    sub._dep = undefined;
  } else {
    // First dep — store directly, no Set allocation
    sub._dep = signal;
  }

  // Register subscriber on the signal
  let subs = (signal as SignalWithCache)[SUBS];
  if (!subs) {
    subs = new Set();
    (signal as SignalWithCache)[SUBS] = subs;
  }
  subs.add(currentSubscriber);
  if (subs.size === 1) {
    (signal as any).__f = currentSubscriber;
  } else if ((signal as any).__f !== undefined) {
    (signal as any).__f = undefined;
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
 * Process all pending subscriber notifications.
 *
 * The drain cap prevents infinite cycles (effect A writes to signal that
 * triggers effect A again forever). Apps with very large legitimate fan-out
 * (e.g. >100k effects in a single batch) can raise it via `setMaxDrainIterations`.
 */
let maxDrainIterations = 100000;

/** Raise/lower the per-batch drain iteration cap. Returns previous value. */
export function setMaxDrainIterations(n: number): number {
  const prev = maxDrainIterations;
  if (Number.isFinite(n) && n > 0) maxDrainIterations = Math.floor(n);
  return prev;
}

export function drainNotificationQueue(): void {
  if (notifyDepth > 0) return;
  notifyDepth++;
  try {
    let i = 0;
    while (i < pendingQueue.length) {
      if (i >= maxDrainIterations) {
        if (typeof console !== "undefined") {
          console.error(
            `[SibuJS] Notification queue exceeded ${maxDrainIterations} iterations — ` +
              "likely an effect that writes to a signal it reads. Breaking to prevent infinite loop.",
          );
        }
        break;
      }
      safeInvoke(pendingQueue[i]);
      i++;
    }
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
 * Two-pass outermost notification:
 *   Pass 1: Computed subscribers run first for dirty propagation (iterative).
 *           Effect subscribers discovered via cascading are queued with dedup.
 *   Pass 2: Direct effect subscribers run, skipping those already queued
 *           by cascading (fixes diamond double-execution).
 *   Pass 3: Drain any remaining cascading effects.
 *
 * This avoids adding ALL subscribers to pendingSet upfront (which would add
 * overhead to the common flat fan-out case with 10K+ effects).
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
    try {
      if (first._c) {
        propagateDirty(first);
      } else {
        safeInvoke(first);
      }
      // Drain cascading effects
      let i = 0;
      while (i < pendingQueue.length) {
        if (i >= maxDrainIterations) {
          if (typeof console !== "undefined") {
            console.error(
              `[SibuJS] Notification queue exceeded ${maxDrainIterations} iterations — ` +
                "likely an effect that writes to a signal it reads. Breaking to prevent infinite loop.",
            );
          }
          break;
        }
        safeInvoke(pendingQueue[i]);
        i++;
      }
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

  // Outermost notification
  notifyDepth++;
  try {
    // Snapshot direct subscribers, noting whether any are computed.
    // If none are computed, skip Pass 1/2 machinery and invoke directly.
    let directCount = 0;
    let hasComputedSub = false;
    for (const sub of subs) {
      if ((sub as any)._c) hasComputedSub = true;
      pendingQueue[directCount++] = sub;
    }

    if (!hasComputedSub) {
      // Fast path: pure effect fan-out — invoke directly, no Pass 2 bookkeeping.
      for (let i = 0; i < directCount; i++) {
        safeInvoke(pendingQueue[i]);
      }
    } else {
      // Pass 1: Run computed subscribers for dirty propagation (iterative)
      for (let i = 0; i < directCount; i++) {
        if ((pendingQueue[i] as any)._c) {
          propagateDirty(pendingQueue[i]);
        }
      }

      // Pass 2: Run direct effect subscribers, skip those already queued
      // by cascading during Pass 1 (prevents diamond double-execution).
      // Add sub to pendingSet BEFORE invoking so any re-entrant cascade
      // cannot double-execute the same effect.
      for (let i = 0; i < directCount; i++) {
        const sub = pendingQueue[i];
        if (!(sub as any)._c && !pendingSet.has(sub)) {
          pendingSet.add(sub);
          safeInvoke(sub);
        }
      }
    }

    // Pass 3: Drain cascading effects queued during propagation
    let i = directCount;
    while (i < pendingQueue.length) {
      if (i - directCount >= maxDrainIterations) {
        if (typeof console !== "undefined") {
          console.error(
            `[SibuJS] Notification queue exceeded ${maxDrainIterations} iterations — ` +
              "likely an effect that writes to a signal it reads. Breaking to prevent infinite loop.",
          );
        }
        break;
      }
      safeInvoke(pendingQueue[i]);
      i++;
    }
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
 */
function cleanup(subscriber: Subscriber) {
  const sub = subscriber as any;

  // Fast path: single dependency (no Set to iterate)
  const singleDep: ReactiveSignal | undefined = sub._dep;
  if (singleDep !== undefined) {
    const subs = (singleDep as SignalWithCache)[SUBS];
    if (subs) {
      subs.delete(subscriber);
      if ((singleDep as any).__f === subscriber) {
        (singleDep as any).__f = subs.size === 1 ? subs.values().next().value : undefined;
      } else if (subs.size === 1 && (singleDep as any).__f === undefined) {
        (singleDep as any).__f = subs.values().next().value;
      }
    }
    sub._dep = undefined;
    return;
  }

  // Multi-dep path
  const deps: Set<ReactiveSignal> | undefined = sub._deps;
  if (!deps || deps.size === 0) return;

  for (const signal of deps) {
    const subs = (signal as SignalWithCache)[SUBS];
    if (subs) {
      subs.delete(subscriber);
      if ((signal as any).__f === subscriber) {
        (signal as any).__f = subs.size === 1 ? subs.values().next().value : undefined;
      } else if (subs.size === 1 && (signal as any).__f === undefined) {
        (signal as any).__f = subs.values().next().value;
      }
    }
  }

  deps.clear();
}
