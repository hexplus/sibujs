import type { ReactiveSignal } from "./signal";
import { drainNotificationQueue, queueSignalNotification } from "./track";

// Batch coordination state is plain module-local — the same first-copy-wins
// function-sharing as track.ts (see its file header) keeps it a single source
// of truth across duplicate runtime instances: the first copy publishes its
// batch functions on a globalThis registry and every later copy re-exports
// them, so all copies funnel through ONE copy's batchDepth / pendingSignals.
let batchDepth = 0;
const pendingSignals = new Set<ReactiveSignal>();

/**
 * Batch multiple state updates into a single notification pass.
 * Subscribers are only notified once after the batch completes,
 * preventing excessive re-renders during bulk updates.
 *
 * Can be nested — only the outermost batch triggers notifications.
 *
 * @param fn Function containing state updates to batch
 * @returns The return value of fn
 *
 * @example
 * ```ts
 * const [name, setName] = signal("Alice");
 * const [age, setAge] = signal(25);
 *
 * const result = batch(() => {
 *   setName("Bob");
 *   setAge(30);
 *   return "done";
 * }); // Only one notification pass, result === "done"
 * ```
 */
function batchImpl<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      flushBatch();
    }
  }
}

/**
 * Queue a signal for deferred notification during a batch.
 * If not batching, returns false so the caller can notify immediately.
 */
function enqueueBatchedSignalImpl(signal: ReactiveSignal): boolean {
  if (batchDepth === 0) return false;
  pendingSignals.add(signal);
  return true;
}

/**
 * Check if we're currently inside a batch.
 */
function isBatchingImpl(): boolean {
  return batchDepth > 0;
}

/**
 * Flush all pending signals after a batch completes.
 *
 * Iterates pending signals directly (no intermediate array allocation),
 * then drains once — ensuring each subscriber runs at most once
 * regardless of how many signals changed.
 */
function flushBatch(): void {
  // Clear-before-drain + try/finally so a throwing subscriber during
  // notification can't strand pendingSignals for the next batch.
  try {
    for (const signal of pendingSignals) {
      queueSignalNotification(signal);
    }
  } finally {
    pendingSignals.clear();
  }
  drainNotificationQueue();
}

// ---------- Shared-instance registry (see track.ts) -----------------------

interface BatchApi {
  batch: typeof batchImpl;
  enqueueBatchedSignal: typeof enqueueBatchedSignalImpl;
  isBatching: typeof isBatchingImpl;
}

const BATCH_REGISTRY_KEY = Symbol.for("sibujs.reactive.batch.v1");

function resolveBatchApi(): BatchApi {
  const g = globalThis as typeof globalThis & { [BATCH_REGISTRY_KEY]?: BatchApi };
  const existing = g[BATCH_REGISTRY_KEY];
  if (existing) return existing;
  const local: BatchApi = {
    batch: batchImpl,
    enqueueBatchedSignal: enqueueBatchedSignalImpl,
    isBatching: isBatchingImpl,
  };
  g[BATCH_REGISTRY_KEY] = local;
  return local;
}

const API: BatchApi = resolveBatchApi();

export const batch: BatchApi["batch"] = API.batch;
export const enqueueBatchedSignal: BatchApi["enqueueBatchedSignal"] = API.enqueueBatchedSignal;
export const isBatching: BatchApi["isBatching"] = API.isBatching;
