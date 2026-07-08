// ============================================================================
// PRIORITY-BASED UPDATE SCHEDULER
// ============================================================================

import { globalSingleton } from "@sibujs/core/internal";

export const Priority = {
  IMMEDIATE: 0,
  USER_BLOCKING: 1,
  NORMAL: 2,
  LOW: 3,
  IDLE: 4,
} as const;

export type PriorityLevel = (typeof Priority)[keyof typeof Priority];

interface ScheduledTask {
  id: number;
  priority: PriorityLevel;
  callback: () => void;
  cancelled: boolean;
}

// Distinguish scheduled work by type so we can cancel the right handle.
// Microtasks cannot be cancelled — we only track they are scheduled.
type ScheduledKind = "frame" | "idle" | "timeout" | "microtask";

// Scheduler state is shared via globalSingleton so tasks queued through one
// (possibly duplicated) copy of this module are drained by the same rAF/idle
// loop, instead of splitting into two independent queues that never flush.
const _sched = globalSingleton(Symbol.for("sibujs.scheduler.v1"), () => ({
  taskIdCounter: 0,
  taskQueue: [] as ScheduledTask[],
  isProcessing: false,
  scheduledKind: null as ScheduledKind | null,
  scheduledHandle: null as number | null,
  microtaskScheduled: false,
}));
const taskQueue = _sched.taskQueue;

function insertTask(task: ScheduledTask): void {
  // Insert in priority order (lower number = higher priority)
  let i = taskQueue.length;
  while (i > 0 && taskQueue[i - 1].priority > task.priority) {
    i--;
  }
  taskQueue.splice(i, 0, task);
}

function processQueue(): void {
  if (_sched.isProcessing || taskQueue.length === 0) return;
  _sched.isProcessing = true;

  const startTime = performance.now();
  const timeSlice = 5; // 5ms time slice per frame

  while (taskQueue.length > 0) {
    const task = taskQueue[0];

    if (task.cancelled) {
      taskQueue.shift();
      continue;
    }

    // For non-immediate tasks, check if we've exceeded our time slice
    if (task.priority > Priority.IMMEDIATE && performance.now() - startTime > timeSlice) {
      break;
    }

    taskQueue.shift();
    try {
      task.callback();
    } catch (e) {
      console.error("[Scheduler] Task error:", e);
    }
  }

  _sched.isProcessing = false;

  // Schedule next frame if there are remaining tasks
  if (taskQueue.length > 0) {
    scheduleFrame();
  }
}

// Relative latency of each tier (lower = sooner). Used to decide whether an
// already-scheduled tier is fast enough for the highest-priority pending task.
const TIER_SPEED: Record<ScheduledKind, number> = { microtask: 0, frame: 1, timeout: 2, idle: 3 };

function cancelScheduled(): void {
  if (_sched.scheduledHandle !== null) {
    if (_sched.scheduledKind === "frame") cancelAnimationFrame(_sched.scheduledHandle);
    else if (_sched.scheduledKind === "idle" && typeof cancelIdleCallback !== "undefined")
      cancelIdleCallback(_sched.scheduledHandle);
    else if (_sched.scheduledKind === "timeout") clearTimeout(_sched.scheduledHandle);
  }
  _sched.scheduledHandle = null;
  _sched.scheduledKind = null;
}

function scheduleFrame(): void {
  const nextTask = taskQueue.find((t) => !t.cancelled);
  if (!nextTask) return;

  const desired: ScheduledKind =
    nextTask.priority <= Priority.USER_BLOCKING
      ? "microtask"
      : nextTask.priority === Priority.IDLE
        ? typeof requestIdleCallback !== "undefined"
          ? "idle"
          : "timeout"
        : // NORMAL/LOW prefer a frame, but rAF is absent under SSR — fall back
          // to a timeout so startTransition()/deferredValue() don't throw.
          typeof requestAnimationFrame !== "undefined"
          ? "frame"
          : "timeout";

  // A microtask is the fastest tier — nothing to re-arm faster.
  if (_sched.microtaskScheduled) return;
  if (_sched.scheduledKind !== null) {
    // Keep the existing schedule only if it fires at least as soon as needed.
    // Otherwise a higher-priority task arrived (e.g. USER_BLOCKING behind a
    // pending rAF) — cancel the slower handle and re-arm at the faster tier,
    // instead of making the urgent task wait for the next frame.
    if (TIER_SPEED[_sched.scheduledKind] <= TIER_SPEED[desired]) return;
    cancelScheduled();
  }

  if (desired === "microtask") {
    // Set flag BEFORE queueing to avoid races where another scheduleFrame()
    // call slips through.
    _sched.microtaskScheduled = true;
    _sched.scheduledKind = "microtask";
    queueMicrotask(() => {
      _sched.microtaskScheduled = false;
      _sched.scheduledKind = null;
      processQueue();
    });
  } else if (desired === "idle") {
    _sched.scheduledKind = "idle";
    _sched.scheduledHandle = requestIdleCallback(() => {
      _sched.scheduledKind = null;
      _sched.scheduledHandle = null;
      processQueue();
    }) as unknown as number;
  } else if (desired === "timeout") {
    _sched.scheduledKind = "timeout";
    _sched.scheduledHandle = setTimeout(() => {
      _sched.scheduledKind = null;
      _sched.scheduledHandle = null;
      processQueue();
    }, 50) as unknown as number;
  } else {
    _sched.scheduledKind = "frame";
    _sched.scheduledHandle = requestAnimationFrame(() => {
      _sched.scheduledKind = null;
      _sched.scheduledHandle = null;
      processQueue();
    });
  }
}

/**
 * Schedule an update with a given priority level.
 * Returns a cancel function.
 */
export function scheduleUpdate(priority: PriorityLevel, callback: () => void): () => void {
  const task: ScheduledTask = {
    id: _sched.taskIdCounter++,
    priority,
    callback,
    cancelled: false,
  };

  if (priority === Priority.IMMEDIATE) {
    // Execute synchronously
    try {
      callback();
    } catch (e) {
      console.error("[Scheduler] Immediate task error:", e);
    }
    return () => {};
  }

  insertTask(task);
  scheduleFrame();

  return () => {
    task.cancelled = true;
  };
}

/**
 * Flush all pending tasks synchronously (useful for testing).
 */
export function flushScheduler(): void {
  // Cancel any pending scheduled work. Microtasks are not cancellable, but
  // the callback becomes a no-op once the queue drains.
  if (_sched.scheduledHandle !== null) {
    if (_sched.scheduledKind === "frame") cancelAnimationFrame(_sched.scheduledHandle);
    else if (_sched.scheduledKind === "idle" && typeof cancelIdleCallback !== "undefined") {
      cancelIdleCallback(_sched.scheduledHandle);
    } else if (_sched.scheduledKind === "timeout") clearTimeout(_sched.scheduledHandle);
  }
  _sched.scheduledHandle = null;
  _sched.scheduledKind = null;
  _sched.microtaskScheduled = false;

  while (taskQueue.length > 0) {
    const task = taskQueue.shift();
    if (!task) break;
    if (!task.cancelled) {
      task.callback();
    }
  }
  _sched.isProcessing = false;
}

/**
 * Get the number of pending tasks.
 */
export function pendingTasks(): number {
  return taskQueue.filter((t) => !t.cancelled).length;
}

// ============================================================================
// COOPERATIVE YIELDING
// ============================================================================

/**
 * Yield control back to the main thread, allowing the browser to process
 * user input, rendering, and other high-priority work.
 *
 * Uses `scheduler.yield()` when available (Chrome 115+),
 * falls back to `setTimeout(0)`.
 *
 * @example
 * ```ts
 * for (let i = 0; i < items.length; i++) {
 *   renderItem(items[i]);
 *   if (i % 50 === 0) await yieldToMain();
 * }
 * ```
 */
export function yieldToMain(): Promise<void> {
  if (
    typeof globalThis !== "undefined" &&
    "scheduler" in globalThis &&
    typeof (globalThis as unknown as Record<string, Record<string, unknown>>).scheduler?.yield === "function"
  ) {
    return (globalThis as unknown as { scheduler: { yield: () => Promise<void> } }).scheduler.yield();
  }
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Process an array in chunks, yielding to the main thread between chunks.
 * Prevents long-running loops from blocking the UI.
 *
 * @param items Array of items to process
 * @param processor Callback invoked for each item
 * @param chunkSize Number of items per chunk before yielding (default: 50)
 */
export async function processInChunks<T>(
  items: T[],
  processor: (item: T, index: number) => void,
  chunkSize = 50,
): Promise<void> {
  for (let i = 0; i < items.length; i++) {
    processor(items[i], i);
    // Yield after every full chunk of `chunkSize` items (i.e. once the
    // (i+1)-th item completes), but not after the final item — there is no
    // remaining work to yield for. Previously `i % chunkSize` yielded one item
    // late and processed chunkSize+1 items in the first chunk.
    if ((i + 1) % chunkSize === 0 && i + 1 < items.length) {
      await yieldToMain();
    }
  }
}
