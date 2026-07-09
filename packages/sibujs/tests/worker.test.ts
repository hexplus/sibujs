import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerPool, worker, workerFn } from "../src/platform/worker";

// ---------------------------------------------------------------------------
// Fake Worker + URL infrastructure
//
// jsdom provides no Worker, so we stub a minimal fake that captures the blob
// URL it was constructed with and exposes hooks to drive its event listeners.
// This lets us exercise every code path without a real worker thread.
// ---------------------------------------------------------------------------

interface FakeWorkerInstance {
  url: string;
  posted: unknown[];
  terminated: boolean;
  emitMessage(data: unknown): void;
  emitError(message?: string): void;
}

const instances: FakeWorkerInstance[] = [];

class FakeWorker {
  private listeners: Record<string, ((e: unknown) => void)[]> = {};
  posted: unknown[] = [];
  terminated = false;
  url: string;

  constructor(url: string) {
    this.url = url;
    instances.push(this as unknown as FakeWorkerInstance);
  }

  addEventListener(type: string, cb: (e: unknown) => void): void {
    (this.listeners[type] ||= []).push(cb);
  }

  removeEventListener(type: string, cb: (e: unknown) => void): void {
    const list = this.listeners[type];
    if (list) this.listeners[type] = list.filter((l) => l !== cb);
  }

  postMessage(data: unknown): void {
    this.posted.push(data);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    for (const cb of this.listeners.message || []) cb({ data });
  }

  emitError(message = "boom"): void {
    for (const cb of this.listeners.error || []) cb({ message });
  }
}

let createdUrls: string[] = [];
let revokedUrls: string[] = [];
let urlCounter = 0;

beforeEach(() => {
  instances.length = 0;
  createdUrls = [];
  revokedUrls = [];
  urlCounter = 0;

  (globalThis as Record<string, unknown>).Worker = FakeWorker as unknown;

  // jsdom's URL has no createObjectURL/revokeObjectURL; define them so spyOn works.
  (URL as unknown as Record<string, unknown>).createObjectURL = () => "";
  (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};

  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    const url = `blob:fake-${urlCounter++}`;
    createdUrls.push(url);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
    revokedUrls.push(url);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).Worker;
});

// ---------------------------------------------------------------------------
// worker
// ---------------------------------------------------------------------------
describe("worker", () => {
  it("creates a blob URL and a wired worker", () => {
    const w = worker((e) => {
      void e;
    });
    expect(createdUrls).toHaveLength(1);
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe(createdUrls[0]);
    expect(w.result()).toBeNull();
    expect(w.error()).toBeNull();
    expect(w.loading()).toBe(false);
  });

  it("toString()s the function into the blob source", () => {
    const blobSpy = vi.spyOn(globalThis, "Blob");
    worker(function markerHandler() {});
    const parts = blobSpy.mock.calls[0][0] as string[];
    expect(parts[0]).toContain("self.onmessage =");
    expect(parts[0]).toContain("markerHandler");
    blobSpy.mockRestore();
  });

  it("sets loading on post and resets state", () => {
    const w = worker(() => {});
    w.post({ x: 1 });
    expect(w.loading()).toBe(true);
    expect(instances[0].posted).toEqual([{ x: 1 }]);
  });

  it("receives a result message, clears loading, and revokes the blob URL", () => {
    const w = worker(() => {});
    w.post(1);
    instances[0].emitMessage(42);
    expect(w.result()).toBe(42);
    expect(w.loading()).toBe(false);
    expect(revokedUrls).toContain(createdUrls[0]);
  });

  it("handles an error event by setting error and terminating", () => {
    const w = worker(() => {});
    w.post(1);
    instances[0].emitError("kaboom");
    expect(w.error()).toBeInstanceOf(Error);
    expect(w.error()?.message).toBe("kaboom");
    expect(w.loading()).toBe(false);
    expect(instances[0].terminated).toBe(true);
  });

  it("uses a default message when error event has no message", () => {
    const w = worker(() => {});
    instances[0].emitError("");
    expect(w.error()?.message).toBe("Worker error");
  });

  it("post is a no-op after an error terminated the worker", () => {
    const w = worker(() => {});
    instances[0].emitError();
    const postedBefore = instances[0].posted.length;
    w.post(5);
    expect(instances[0].posted.length).toBe(postedBefore);
    expect(w.loading()).toBe(false);
  });

  it("terminate stops the worker and revokes the blob URL", () => {
    const w = worker(() => {});
    w.terminate();
    expect(instances[0].terminated).toBe(true);
    expect(revokedUrls).toContain(createdUrls[0]);
    // second terminate is a no-op
    w.terminate();
  });

  it("captures an error when Worker is unsupported", () => {
    delete (globalThis as Record<string, unknown>).Worker;
    const w = worker(() => {});
    expect(w.error()).toBeInstanceOf(Error);
    expect(w.error()?.message).toContain("not supported");
  });
});

// ---------------------------------------------------------------------------
// workerFn
// ---------------------------------------------------------------------------
describe("workerFn", () => {
  it("wraps the function and resolves run() with the worker reply", async () => {
    const wf = workerFn((a: number, b: number) => a + b);
    const promise = wf.run(2, 3);
    expect(wf.loading()).toBe(true);
    expect(instances[0].posted).toEqual([[2, 3]]);
    instances[0].emitMessage(5);
    await expect(promise).resolves.toBe(5);
    expect(wf.loading()).toBe(false);
  });

  it("processes multiple queued runs FIFO", async () => {
    const wf = workerFn((x: number) => x);
    const p1 = wf.run(1);
    const p2 = wf.run(2);
    instances[0].emitMessage("first");
    expect(wf.loading()).toBe(true); // still one pending
    instances[0].emitMessage("second");
    expect(wf.loading()).toBe(false);
    await expect(p1).resolves.toBe("first");
    await expect(p2).resolves.toBe("second");
  });

  it("rejects all pending runs on an error and terminates", async () => {
    const wf = workerFn((x: number) => x);
    const p1 = wf.run(1);
    const p2 = wf.run(2);
    instances[0].emitError("dead");
    await expect(p1).rejects.toThrow("dead");
    await expect(p2).rejects.toThrow("dead");
    expect(instances[0].terminated).toBe(true);
    expect(wf.loading()).toBe(false);
  });

  it("rejects run() when the worker is unavailable", async () => {
    delete (globalThis as Record<string, unknown>).Worker;
    const wf = workerFn((x: number) => x);
    await expect(wf.run(1)).rejects.toThrow("not available");
  });

  it("terminate rejects pending runs and revokes the blob URL", async () => {
    const wf = workerFn((x: number) => x);
    const p = wf.run(1);
    wf.terminate();
    await expect(p).rejects.toThrow("terminated");
    expect(instances[0].terminated).toBe(true);
    expect(revokedUrls).toContain(createdUrls[0]);
    wf.terminate(); // no-op second time
  });
});

// ---------------------------------------------------------------------------
// createWorkerPool
// ---------------------------------------------------------------------------
describe("createWorkerPool", () => {
  it("creates poolSize workers", () => {
    createWorkerPool(() => {}, 3);
    expect(instances).toHaveLength(3);
  });

  it("defaults pool size from navigator.hardwareConcurrency or 4", () => {
    const orig = Object.getOwnPropertyDescriptor(navigator, "hardwareConcurrency");
    Object.defineProperty(navigator, "hardwareConcurrency", { value: 2, configurable: true });
    createWorkerPool(() => {});
    expect(instances).toHaveLength(2);
    if (orig) Object.defineProperty(navigator, "hardwareConcurrency", orig);
  });

  it("distributes tasks round-robin and resolves results", async () => {
    const pool = createWorkerPool<number, number>(() => {}, 2);
    const p1 = pool.execute(10);
    const p2 = pool.execute(20);
    expect(instances[0].posted).toEqual([10]);
    expect(instances[1].posted).toEqual([20]);
    instances[0].emitMessage(100);
    instances[1].emitMessage(200);
    await expect(p1).resolves.toBe(100);
    await expect(p2).resolves.toBe(200);
  });

  it("queues a second task on the same worker until the first completes", async () => {
    const pool = createWorkerPool<number, number>(() => {}, 1);
    const p1 = pool.execute(1);
    const p2 = pool.execute(2);
    // only the first task is dispatched while one is in flight
    expect(instances[0].posted).toEqual([1]);
    instances[0].emitMessage("a");
    await expect(p1).resolves.toBe("a");
    // now the queued task is dispatched
    expect(instances[0].posted).toEqual([1, 2]);
    instances[0].emitMessage("b");
    await expect(p2).resolves.toBe("b");
  });

  it("rejects a task when the worker errors", async () => {
    const pool = createWorkerPool<number, number>(() => {}, 1);
    const p = pool.execute(1);
    instances[0].emitError("pool-error");
    await expect(p).rejects.toThrow("pool-error");
  });

  it("keeps the shared blob URL live until terminate, then revokes it once", async () => {
    const pool = createWorkerPool<number, number>(() => {}, 2);
    const p1 = pool.execute(1);
    const p2 = pool.execute(2);
    instances[0].emitMessage("x");
    instances[1].emitMessage("y");
    await Promise.all([p1, p2]);
    // Not revoked on the first message: other pool workers may still be loading
    // their script from that blob URL, so revoking early would break them.
    expect(revokedUrls.filter((u) => u === createdUrls[0])).toHaveLength(0);
    pool.terminate();
    // Revoked exactly once on teardown.
    expect(revokedUrls.filter((u) => u === createdUrls[0])).toHaveLength(1);
  });

  it("terminate kills all workers and rejects inflight + queued tasks", async () => {
    const pool = createWorkerPool<number, number>(() => {}, 1);
    const inflight = pool.execute(1); // dispatched
    const queued = pool.execute(2); // queued behind it
    pool.terminate();
    await expect(inflight).rejects.toThrow("terminated");
    await expect(queued).rejects.toThrow("terminated");
    expect(instances[0].terminated).toBe(true);
  });

  it("rejects execute() after the pool is terminated", async () => {
    const pool = createWorkerPool<number, number>(() => {}, 1);
    pool.terminate();
    await expect(pool.execute(1)).rejects.toThrow("not available");
  });

  it("rejects execute() when Worker is unsupported (empty pool)", async () => {
    delete (globalThis as Record<string, unknown>).Worker;
    const pool = createWorkerPool<number, number>(() => {}, 1);
    await expect(pool.execute(1)).rejects.toThrow("not available");
  });
});
