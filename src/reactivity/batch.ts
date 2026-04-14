import type { ReactiveSignal } from "./signal";
import { drainNotificationQueue, queueSignalNotification } from "./track";

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
export function batch<T>(fn: () => T): T {
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
export function enqueueBatchedSignal(signal: ReactiveSignal): boolean {
  if (batchDepth === 0) return false;
  pendingSignals.add(signal);
  return true;
}

/**
 * Check if we're currently inside a batch.
 */
export function isBatching(): boolean {
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
