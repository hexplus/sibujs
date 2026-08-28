/**
 * `createChunkRegistry()` lifecycle callbacks are OBSERVERS, not participants.
 *
 * WHAT WAS WRONG
 * --------------
 * `onLoadStart` / `onLoadEnd` / `onLoadError` ran inside the operation's own
 * control flow, so a throwing observer changed what the operation did:
 *
 *   - `onLoadStart` ran before the loader, so a throwing one meant the chunk was
 *     never loaded at all;
 *   - `onLoadEnd` ran inside the `.then`, so a throwing one turned a successful,
 *     already-cached load into a rejection — and because the `.catch` was
 *     chained after it, the observer's own error was then delivered to
 *     `onLoadError` as though the loader had failed. The caller was told
 *     "failed" while `registry.get(id)` returned the value. That state is not
 *     merely surprising, it is self-contradictory.
 *   - `onLoadError` could replace the loader's error with its own, destroying
 *     the only diagnostic the caller had.
 *
 * Callback failures are now contained and reported through the runtime error
 * pipeline, which is the same route every other contained user-callback
 * exception takes. They are not swallowed, and they cannot reach the operation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { createChunkRegistry } from "../src/performance/chunkLoader";

function settle<T>(p: Promise<T>) {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Capture everything the runtime error pipeline reports during `run`. */
async function withReportedErrors(
  run: () => Promise<void>,
): Promise<Array<{ error: unknown; phase: string; name?: string }>> {
  const reported: Array<{ error: unknown; phase: string; name?: string }> = [];
  const previous = setRuntimeErrorHandler((error, context) => {
    reported.push({ error, phase: context.phase, name: context.name });
  });
  try {
    await run();
  } finally {
    setRuntimeErrorHandler(previous);
  }
  return reported;
}

afterEach(() => {
  setRuntimeErrorHandler(null);
  vi.restoreAllMocks();
});

describe("chunk lifecycle callbacks — non-throwing baseline", () => {
  it("fires onLoadStart then onLoadEnd for a successful load", async () => {
    const order: string[] = [];
    const registry = createChunkRegistry({
      retries: 0,
      onLoadStart: (id) => order.push(`start:${id}`),
      onLoadEnd: (id) => order.push(`end:${id}`),
      onLoadError: (id) => order.push(`error:${id}`),
    });

    const result = await settle(registry.load("a", async () => "loaded"));
    expect(result).toEqual({ ok: true, value: "loaded" });
    expect(order).toEqual(["start:a", "end:a"]);
    expect(registry.get("a")).toBe("loaded");
  });

  it("fires onLoadStart then onLoadError for a failed load, exactly once", async () => {
    const order: string[] = [];
    const errors: Error[] = [];
    const registry = createChunkRegistry({
      retries: 0,
      onLoadStart: (id) => order.push(`start:${id}`),
      onLoadEnd: (id) => order.push(`end:${id}`),
      onLoadError: (id, e) => {
        order.push(`error:${id}`);
        errors.push(e);
      },
    });

    const boom = new Error("loader failed");
    const result = await settle(registry.load("a", () => Promise.reject(boom)));

    expect(result.ok).toBe(false);
    expect(order).toEqual(["start:a", "error:a"]);
    expect(errors).toEqual([boom]);
    expect(registry.stats()).toEqual({ size: 0, maxSize: 50, pending: 0, preloaded: 0 });
  });
});

describe("chunk lifecycle callbacks — a throwing observer cannot change the outcome", () => {
  it("a throwing onLoadStart does not prevent the loader from running", async () => {
    const loader = vi.fn(async () => "loaded");
    const observerError = new Error("start observer failed");
    let registry!: ReturnType<typeof createChunkRegistry>;
    let result!: { ok: boolean; value?: unknown; error?: unknown };

    const reported = await withReportedErrors(async () => {
      registry = createChunkRegistry({
        retries: 0,
        onLoadStart: () => {
          throw observerError;
        },
      });
      result = await settle(registry.load("a", loader));
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, value: "loaded" });
    expect(registry.get("a")).toBe("loaded");
    expect(registry.stats()).toEqual({ size: 1, maxSize: 50, pending: 0, preloaded: 0 });

    expect(reported).toHaveLength(1);
    expect(reported[0].error).toBe(observerError);
    expect(reported[0].phase).toBe("async");
    expect(reported[0].name).toBe("chunkRegistry(onLoadStart)");
  });

  it("a throwing onLoadEnd does not convert success into failure", async () => {
    const observerError = new Error("end observer failed");
    const onLoadError = vi.fn();
    let registry!: ReturnType<typeof createChunkRegistry>;
    let result!: { ok: boolean; value?: unknown; error?: unknown };

    const reported = await withReportedErrors(async () => {
      registry = createChunkRegistry({
        retries: 0,
        onLoadEnd: () => {
          throw observerError;
        },
        onLoadError,
      });
      result = await settle(registry.load("a", async () => "loaded"));
    });

    // The caller is told the truth, and the truth matches the cache.
    expect(result).toEqual({ ok: true, value: "loaded" });
    expect(registry.get("a")).toBe("loaded");
    expect(registry.has("a")).toBe(true);
    expect(registry.stats()).toEqual({ size: 1, maxSize: 50, pending: 0, preloaded: 0 });

    // `onLoadError` is for LOADER failures; an observer's own exception is not one.
    expect(onLoadError).not.toHaveBeenCalled();

    expect(reported).toHaveLength(1);
    expect(reported[0].error).toBe(observerError);
    expect(reported[0].name).toBe("chunkRegistry(onLoadEnd)");
  });

  it("a throwing onLoadError does not replace the original loader error", async () => {
    const loaderError = new Error("loader failed");
    const observerError = new Error("error observer failed");
    let registry!: ReturnType<typeof createChunkRegistry>;
    let result!: { ok: boolean; value?: unknown; error?: unknown };
    const seen: Error[] = [];

    const reported = await withReportedErrors(async () => {
      registry = createChunkRegistry({
        retries: 0,
        onLoadError: (_id, e) => {
          seen.push(e);
          throw observerError;
        },
      });
      result = await settle(registry.load("a", () => Promise.reject(loaderError)));
    });

    expect(result.ok).toBe(false);
    expect(result.error, "the observer's error replaced the loader's").toBe(loaderError);
    expect(seen, "onLoadError fired more than once").toEqual([loaderError]);
    expect(registry.stats()).toEqual({ size: 0, maxSize: 50, pending: 0, preloaded: 0 });

    expect(reported).toHaveLength(1);
    expect(reported[0].error).toBe(observerError);
    expect(reported[0].name).toBe("chunkRegistry(onLoadError)");
  });

  it("every observer throwing at once still leaves a coherent success", async () => {
    const loader = vi.fn(async () => "loaded");
    let registry!: ReturnType<typeof createChunkRegistry>;
    let result!: { ok: boolean; value?: unknown; error?: unknown };

    const reported = await withReportedErrors(async () => {
      registry = createChunkRegistry({
        retries: 0,
        onLoadStart: () => {
          throw new Error("start");
        },
        onLoadEnd: () => {
          throw new Error("end");
        },
        onLoadError: () => {
          throw new Error("error");
        },
      });
      result = await settle(registry.load("a", loader));
    });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, value: "loaded" });
    expect(registry.get("a")).toBe("loaded");
    expect(reported.map((r) => r.name)).toEqual(["chunkRegistry(onLoadStart)", "chunkRegistry(onLoadEnd)"]);
  });

  it("reporting a callback failure never throws, even with a broken handler", async () => {
    // `reportError` contains a throwing handler and falls through to the console,
    // so a hostile handler cannot corrupt the load either.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const previous = setRuntimeErrorHandler(() => {
      throw new Error("handler itself throws");
    });
    try {
      const registry = createChunkRegistry({
        retries: 0,
        onLoadEnd: () => {
          throw new Error("end observer failed");
        },
      });
      const result = await settle(registry.load("a", async () => "loaded"));
      expect(result).toEqual({ ok: true, value: "loaded" });
      expect(registry.get("a")).toBe("loaded");
    } finally {
      setRuntimeErrorHandler(previous);
      consoleError.mockRestore();
    }
  });
});

describe("chunk lifecycle callbacks — during preload", () => {
  it("a throwing onLoadEnd during preload still caches the value", async () => {
    // The public caller does not await a preload, so a callback that broke the
    // operation here would fail completely silently.
    const observerError = new Error("end observer failed");
    let registry!: ReturnType<typeof createChunkRegistry>;

    const reported = await withReportedErrors(async () => {
      registry = createChunkRegistry({
        retries: 0,
        onLoadEnd: () => {
          throw observerError;
        },
      });
      registry.preload("a", async () => "loaded");
      await tick();
      await tick();
    });

    expect(registry.get("a")).toBe("loaded");
    expect(registry.stats().preloaded).toBe(1);
    expect(reported).toHaveLength(1);
    expect(reported[0].error).toBe(observerError);
  });

  it("a throwing onLoadError during preload leaves the guard retryable", async () => {
    let registry!: ReturnType<typeof createChunkRegistry>;

    const reported = await withReportedErrors(async () => {
      registry = createChunkRegistry({
        retries: 0,
        onLoadError: () => {
          throw new Error("error observer failed");
        },
      });
      registry.preload("a", () => Promise.reject(new Error("loader failed")));
      await tick();
      await tick();
    });

    expect(registry.stats()).toEqual({ size: 0, maxSize: 50, pending: 0, preloaded: 0 });
    expect(reported).toHaveLength(1);
    expect(reported[0].name).toBe("chunkRegistry(onLoadError)");

    // …and the chunk can still be preloaded again.
    registry.preload("a", async () => "second try");
    await tick();
    await tick();
    expect(registry.get("a")).toBe("second try");
  });

  it("no unhandled rejection escapes any callback path", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const registry = createChunkRegistry({
        retries: 0,
        onLoadStart: () => {
          throw new Error("start");
        },
        onLoadEnd: () => {
          throw new Error("end");
        },
        onLoadError: () => {
          throw new Error("error");
        },
      });
      registry.preload("ok", async () => "v");
      registry.preload("bad", () => Promise.reject(new Error("loader failed")));
      await tick();
      await tick();
      await tick();
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      consoleError.mockRestore();
    }
  });
});
