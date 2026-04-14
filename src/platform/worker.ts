import { signal } from "../core/signals/signal";

// ============================================================================
// WEB WORKER HOOKS
// ============================================================================

export interface UseWorkerReturn<TInput, TOutput> {
  post(data: TInput): void;
  result: () => TOutput | null;
  error: () => Error | null;
  loading: () => boolean;
  terminate(): void;
}

/**
 * worker creates a Web Worker from an inline function and provides
 * reactive state for its result, error, and loading status.
 *
 * The workerFn receives messages via the standard `onmessage` handler
 * and should call `postMessage` to send results back. It is serialized
 * into a Blob URL, so it must be self-contained (no closures).
 *
 * **CSP Warning:** This function serializes the provided function via `.toString()`
 * and executes it inside a `blob:` URL Worker. This is equivalent to `eval()` and
 * is incompatible with strict Content Security Policies that restrict
 * `worker-src 'self'` or block `blob:` URLs. Additionally:
 * - Minifiers may break captured variable references (closures silently fail).
 * - Module-level imports are NOT accessible inside the worker.
 * - Never pass user-controlled or dynamically constructed functions — this
 *   would be equivalent to `eval()` on untrusted input.
 *
 * @param workerFn The function body to run inside the worker.
 *                 It receives `self` as the worker global scope.
 * @returns An object with post, result, error, loading, and terminate.
 */
export function worker<TInput = unknown, TOutput = unknown>(
  workerFn: (e: MessageEvent<TInput>) => void,
): UseWorkerReturn<TInput, TOutput> {
  const [result, setResult] = signal<TOutput | null>(null);
  const [error, setError] = signal<Error | null>(null);
  const [loading, setLoading] = signal(false);

  let worker: Worker | null = null;
  let blobUrl: string | null = null;

  const revokeBlobUrl = () => {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
  };

  try {
    if (typeof Worker === "undefined") {
      throw new Error("Web Workers are not supported in this environment");
    }

    const fnBody = workerFn.toString();
    const blob = new Blob([`self.onmessage = ${fnBody};`], { type: "application/javascript" });
    blobUrl = URL.createObjectURL(blob);
    worker = new Worker(blobUrl);

    worker.addEventListener("message", (e: MessageEvent<TOutput>) => {
      revokeBlobUrl();
      setResult(e.data);
      setLoading(false);
    });

    worker.addEventListener("error", (e: ErrorEvent) => {
      revokeBlobUrl();
      setError(new Error(e.message || "Worker error"));
      setLoading(false);
      // Mirror workerFn behavior: terminate on uncaught error so subsequent
      // post() calls fail fast rather than silently target a broken worker.
      if (worker) {
        worker.terminate();
        worker = null;
      }
    });
  } catch (err) {
    revokeBlobUrl();
    setError(err instanceof Error ? err : new Error(String(err)));
  }

  function post(data: TInput): void {
    if (!worker) return;
    setLoading(true);
    setError(null);
    setResult(null);
    worker.postMessage(data);
  }

  function terminate(): void {
    if (!worker) return;
    worker.terminate();
    worker = null;
    revokeBlobUrl();
    setLoading(false);
  }

  return { post, result, error, loading, terminate };
}

// ============================================================================
// USE WORKER FUNCTION
// ============================================================================

export interface UseWorkerFnReturn<TArgs extends unknown[], TResult> {
  run(...args: TArgs): Promise<TResult>;
  loading: () => boolean;
  terminate(): void;
}

/**
 * workerFn wraps a pure function so it runs inside a Web Worker.
 *
 * The function must be self-contained -- it cannot reference variables
 * from the outer scope. Arguments are serialized via postMessage.
 *
 * @param fn A pure function to execute in a worker thread.
 * @returns An object with run, loading, and terminate.
 */
export function workerFn<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult,
): UseWorkerFnReturn<TArgs, TResult> {
  const [loading, setLoading] = signal(false);

  let worker: Worker | null = null;
  let blobUrl: string | null = null;

  const revokeBlobUrl = () => {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
  };

  // FIFO queue of pending run() promises. The worker processes postMessage
  // in order, so the head of the queue corresponds to the next reply.
  const queue: { resolve: (v: TResult) => void; reject: (e: Error) => void }[] = [];

  try {
    if (typeof Worker === "undefined") {
      throw new Error("Web Workers are not supported in this environment");
    }

    const fnStr = fn.toString();
    const blob = new Blob(
      [
        `self.onmessage = function(e) {
  var fn = ${fnStr};
  var result = fn.apply(null, e.data);
  postMessage(result);
};`,
      ],
      { type: "application/javascript" },
    );
    blobUrl = URL.createObjectURL(blob);
    worker = new Worker(blobUrl);
    worker.addEventListener("message", (e: MessageEvent<TResult>) => {
      revokeBlobUrl();
      const head = queue.shift();
      if (queue.length === 0) setLoading(false);
      if (head) head.resolve(e.data);
    });
    worker.addEventListener("error", (e: ErrorEvent) => {
      // Worker error events do not carry a request id, so we cannot know
      // which pending run() failed. Reject ALL pending and terminate so
      // future run() calls fail fast rather than silently mis-routing.
      revokeBlobUrl();
      const err = new Error(e.message || "Worker error");
      while (queue.length > 0) queue.shift()!.reject(err);
      setLoading(false);
      if (worker) {
        worker.terminate();
        worker = null;
      }
    });
  } catch {
    revokeBlobUrl();
  }

  function run(...args: TArgs): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      if (!worker) {
        reject(new Error("Worker is not available"));
        return;
      }
      setLoading(true);
      queue.push({ resolve, reject });
      worker.postMessage(args);
    });
  }

  function terminate(): void {
    if (!worker) return;
    worker.terminate();
    worker = null;
    const err = new Error("Worker terminated");
    while (queue.length > 0) queue.shift()!.reject(err);
    revokeBlobUrl();
    setLoading(false);
  }

  return { run, loading, terminate };
}

// ============================================================================
// WORKER POOL
// ============================================================================

export interface WorkerPool<TInput, TOutput> {
  execute(data: TInput): Promise<TOutput>;
  terminate(): void;
}

/**
 * createWorkerPool creates a pool of workers for parallel task execution.
 *
 * Tasks are distributed across workers using round-robin scheduling.
 * Each worker is created from the same inline function.
 *
 * @param workerFn The function body to run inside each worker.
 * @param poolSize Number of workers in the pool (defaults to navigator.hardwareConcurrency or 4).
 * @returns An object with execute and terminate.
 */
export function createWorkerPool<TInput = unknown, TOutput = unknown>(
  workerFn: (e: MessageEvent<TInput>) => void,
  poolSize?: number,
): WorkerPool<TInput, TOutput> {
  const size = poolSize || (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;

  type Slot = { data: TInput; resolve: (v: TOutput) => void; reject: (e: Error) => void };
  type Slot2 = Slot & { onMsg: (e: MessageEvent<TOutput>) => void; onErr: (e: ErrorEvent) => void };
  const workers: Worker[] = [];
  const queues: Slot[][] = [];
  const inflight: (Slot2 | null)[] = [];
  let currentIndex = 0;
  let alive = true;
  let blobUrl: string | null = null;
  let firedOnce = false;

  const revokeBlobUrl = () => {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = null;
    }
  };

  function dispatchNext(idx: number) {
    if (!alive || inflight[idx] || queues[idx].length === 0) return;
    const w = workers[idx];
    const slot = queues[idx].shift() as Slot;
    const onMsg = (e: MessageEvent<TOutput>) => {
      if (!firedOnce) {
        firedOnce = true;
        revokeBlobUrl();
      }
      w.removeEventListener("message", onMsg);
      w.removeEventListener("error", onErr);
      inflight[idx] = null;
      slot.resolve(e.data);
      dispatchNext(idx);
    };
    const onErr = (e: ErrorEvent) => {
      if (!firedOnce) {
        firedOnce = true;
        revokeBlobUrl();
      }
      w.removeEventListener("message", onMsg);
      w.removeEventListener("error", onErr);
      inflight[idx] = null;
      slot.reject(new Error(e.message || "Worker error"));
      dispatchNext(idx);
    };
    inflight[idx] = { ...slot, onMsg, onErr };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    w.postMessage(slot.data);
  }

  try {
    if (typeof Worker === "undefined") {
      throw new Error("Web Workers are not supported in this environment");
    }
    const fnBody = workerFn.toString();
    const blob = new Blob([`self.onmessage = ${fnBody};`], { type: "application/javascript" });
    blobUrl = URL.createObjectURL(blob);
    for (let i = 0; i < size; i++) {
      workers.push(new Worker(blobUrl));
      queues.push([]);
      inflight.push(null);
    }
  } catch {
    revokeBlobUrl();
  }

  function execute(data: TInput): Promise<TOutput> {
    return new Promise<TOutput>((resolve, reject) => {
      if (!alive || workers.length === 0) {
        reject(new Error("Worker pool is not available"));
        return;
      }
      const idx = currentIndex % workers.length;
      currentIndex++;
      queues[idx].push({ data, resolve, reject });
      dispatchNext(idx);
    });
  }

  function terminate(): void {
    alive = false;
    for (const w of workers) w.terminate();
    const err = new Error("Worker pool terminated");
    for (let i = 0; i < queues.length; i++) {
      const inf = inflight[i];
      if (inf) inf.reject(err);
      for (const s of queues[i]) s.reject(err);
      queues[i] = [];
      inflight[i] = null;
    }
    workers.length = 0;
    revokeBlobUrl();
  }

  return { execute, terminate };
}
