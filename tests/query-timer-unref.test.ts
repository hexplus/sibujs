// @vitest-environment node
//
// RC-002: the query cache's garbage-collection timer pinned the Node event loop.
//
// When the last observer detaches, `detachFromEntry()` schedules a `setTimeout`
// for `cacheTime` (default 300 000 ms) to collect the entry. That retention
// window is correct and intentional — a remount inside it reuses the cached
// entry. What was not intentional is that the timer is *ref'd*: in Node it keeps
// the process alive for the full five minutes after the work is finished.
//
// Browsers do not care. Node does: an SSG build, a CLI, a script, or a
// serverless invocation that touches `query()` hangs for five minutes after
// printing its output. This was invisible to the existing suite because the
// whole data-layer suite runs under jsdom, where timer handles have no `unref`
// and the runner tears the environment down anyway.
//
// The fix must not change *when* the timer fires — only whether it holds the
// loop open. Every other data-layer timer (retry backoff, debounce, throttle)
// represents work a caller is actively awaiting and is deliberately left ref'd.
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetQueryCache, query } from "../src/data/query";

interface Scheduled {
  delay: number;
  handle: ReturnType<typeof setTimeout>;
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetQueryCache();
});

/** Run `fn` while recording every `setTimeout` scheduled during it. */
function recordingTimers<T>(fn: () => T): { result: T; scheduled: Scheduled[] } {
  const scheduled: Scheduled[] = [];
  const real = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    cb: () => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    const handle = (real as unknown as (...a: unknown[]) => ReturnType<typeof setTimeout>)(cb, delay, ...rest);
    scheduled.push({ delay: delay ?? 0, handle });
    return handle;
  }) as typeof setTimeout);
  try {
    return { result: fn(), scheduled };
  } finally {
    spy.mockRestore();
  }
}

describe("query cache GC timer does not pin the Node event loop", () => {
  it("this runtime has unref-able timers (guards the test's own premise)", () => {
    const h = setTimeout(() => {}, 1000);
    expect(typeof (h as unknown as { unref?: unknown }).unref).toBe("function");
    clearTimeout(h);
  });

  it("schedules the GC timer unref'd when the last observer detaches", async () => {
    const q = query("rc002-key", async () => "value", { cacheTime: 300_000 });
    await vi.waitFor(() => expect(q.data()).toBe("value"));

    const { scheduled } = recordingTimers(() => {
      q.dispose();
    });

    const gc = scheduled.filter((s) => s.delay === 300_000);
    expect(gc.length).toBe(1);

    const handle = gc[0].handle as unknown as { hasRef?: () => boolean };
    expect(typeof handle.hasRef).toBe("function");
    // Before the fix this was `true` — the timer held the process open for the
    // full five-minute retention window.
    expect(handle.hasRef?.()).toBe(false);

    clearTimeout(gc[0].handle);
  });

  it("still collects the entry when the timer fires", async () => {
    vi.useFakeTimers();
    try {
      const q = query("rc002-collect", async () => "value", { cacheTime: 1_000 });
      await vi.waitFor(() => expect(q.data()).toBe("value"), { timeout: 2000, interval: 1 });
      q.dispose();

      // Unref must not change *when* the timer fires, only whether it keeps the
      // loop alive. A fresh observer after collection must re-fetch.
      await vi.advanceTimersByTimeAsync(1_500);

      let fetches = 0;
      const q2 = query("rc002-collect", async () => {
        fetches++;
        return "refetched";
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(fetches).toBe(1);
      q2.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
