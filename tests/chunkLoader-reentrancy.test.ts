/**
 * `createChunkRegistry()` — ownership exists before any user callback runs.
 *
 * WHAT WAS WRONG
 * --------------
 * `onLoadStart` fired before the pending entry was installed, so between the
 * operation publicly starting and the operation owning anything there was a
 * window in which the registry could be re-entered:
 *
 *   - `invalidate(id)` / `clear()` from inside `onLoadStart` deleted a key with
 *     no pending entry to delete. The load then installed itself and published
 *     anyway, so the invalidation was silently skipped and `has(id)` was `true`
 *     for data the caller had already discarded.
 *   - a reentrant `load(id, …)` from inside `onLoadStart` found no pending entry
 *     and started a SECOND loader — which fired `onLoadStart` again, and again.
 *     In the reproduction for this file that recursed 1889 times before
 *     unwinding, and the outer `pending.set` then overwrote whatever ownership
 *     the nested calls had established.
 *
 * `onLoadStart` means the operation has started, so the registry must already
 * reflect it. The entry is now installed first, backed by a deferred the loader
 * settles, and only then does user code run.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { createChunkRegistry } from "../src/performance/chunkLoader";
import { createDeferred, type Deferred } from "./helpers/mocks";

function gate<T = void>(): Deferred<T> {
  const d = createDeferred<T>();
  d.promise.catch(() => {});
  return d;
}

function settle<T>(p: Promise<T>) {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const EMPTY = { size: 0, maxSize: 50, pending: 0, preloaded: 0 };

afterEach(() => {
  setRuntimeErrorHandler(null);
});

describe("invalidation from inside onLoadStart is a real barrier", () => {
  it("invalidate(id) inside onLoadStart prevents publication", async () => {
    let registry!: ReturnType<typeof createChunkRegistry>;
    registry = createChunkRegistry({
      retries: 0,
      timeout: 0,
      onLoadStart: (id) => {
        registry.invalidate(id);
      },
    });

    // The caller still gets its value — nothing is cancelled…
    await expect(registry.load("a", async () => "stale")).resolves.toBe("stale");
    // …but the discarded key stays discarded.
    expect(registry.has("a")).toBe(false);
    expect(registry.stats()).toEqual(EMPTY);
  });

  it("clear() inside onLoadStart prevents publication", async () => {
    let registry!: ReturnType<typeof createChunkRegistry>;
    registry = createChunkRegistry({
      retries: 0,
      timeout: 0,
      onLoadStart: () => {
        registry.clear();
      },
    });

    await expect(registry.load("a", async () => "stale")).resolves.toBe("stale");
    expect(registry.has("a")).toBe(false);
    expect(registry.stats()).toEqual(EMPTY);
  });

  it("a load invalidated from onLoadStart still reports through the lifecycle", async () => {
    const events: string[] = [];
    let registry!: ReturnType<typeof createChunkRegistry>;
    registry = createChunkRegistry({
      retries: 0,
      timeout: 0,
      onLoadStart: (id) => {
        events.push(`start:${id}`);
        registry.invalidate(id);
      },
      onLoadEnd: (id) => events.push(`end:${id}`),
      onLoadError: (id) => events.push(`error:${id}`),
    });

    await registry.load("a", async () => "stale");
    expect(events).toEqual(["start:a", "end:a"]);
    expect(registry.has("a")).toBe(false);
  });

  it("a failing load invalidated from onLoadStart still rejects for its caller", async () => {
    let registry!: ReturnType<typeof createChunkRegistry>;
    registry = createChunkRegistry({
      retries: 0,
      timeout: 0,
      onLoadStart: (id) => {
        registry.invalidate(id);
      },
    });

    const boom = new Error("loader failed");
    const result = await settle(registry.load("a", () => Promise.reject(boom)));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(boom);
    expect(registry.stats()).toEqual(EMPTY);
  });

  it("a stale settlement does not delete a newer pending entry created after reentrant invalidation", async () => {
    let registry!: ReturnType<typeof createChunkRegistry>;
    let invalidateOnce = true;
    registry = createChunkRegistry({
      retries: 0,
      timeout: 0,
      onLoadStart: (id) => {
        if (!invalidateOnce) return;
        invalidateOnce = false;
        registry.invalidate(id);
      },
    });

    const first = gate<string>();
    const second = gate<string>();
    const p1 = settle(registry.load("a", () => first.promise));
    // The first load was invalidated from inside its own onLoadStart, so this
    // starts genuinely new work rather than adopting it.
    const p2 = settle(registry.load("a", () => second.promise));
    expect(registry.stats().pending).toBe(1);

    first.resolve("stale");
    await p1;
    await tick();
    expect(registry.stats().pending, "the stale settlement deleted the newer entry").toBe(1);

    second.resolve("fresh");
    await p2;
    expect(registry.get("a")).toBe("fresh");
    expect(registry.stats()).toEqual({ ...EMPTY, size: 1 });
  });
});

describe("reentrant loading preserves deduplication", () => {
  it("a same-key load() inside onLoadStart shares the established operation", async () => {
    let registry!: ReturnType<typeof createChunkRegistry>;
    const loader = vi.fn(async () => "v");
    let nested: Promise<unknown> | null = null;

    registry = createChunkRegistry({
      retries: 0,
      timeout: 0,
      onLoadStart: (id) => {
        // Unguarded on purpose: before the fix this recursed until the stack
        // unwound, because each nested call found no owner and started again.
        nested = registry.load(id, loader);
      },
    });

    const outer = await registry.load("a", loader);
    const inner = await nested;

    expect(loader, "the nested call started a second loader").toHaveBeenCalledTimes(1);
    expect(outer).toBe("v");
    expect(inner).toBe("v");
    expect(registry.get("a")).toBe("v");
    expect(registry.stats()).toEqual({ ...EMPTY, size: 1 });
  });

  it("a same-key preload() inside onLoadStart does not start a second loader", async () => {
    let registry!: ReturnType<typeof createChunkRegistry>;
    const loader = vi.fn(async () => "v");
    const other = vi.fn(async () => "other");

    registry = createChunkRegistry({
      retries: 0,
      timeout: 0,
      onLoadStart: (id) => {
        registry.preload(id, other);
      },
    });

    await registry.load("a", loader);
    await tick();

    expect(loader).toHaveBeenCalledTimes(1);
    expect(other, "the reentrant preload started its own loader").not.toHaveBeenCalled();
    expect(registry.get("a")).toBe("v");
  });

  it("a load() inside a preload's onLoadStart shares the same operation", async () => {
    let registry!: ReturnType<typeof createChunkRegistry>;
    const loader = vi.fn(async () => "v");
    let nested: Promise<unknown> | null = null;

    registry = createChunkRegistry({
      retries: 0,
      timeout: 0,
      onLoadStart: (id) => {
        nested = registry.load(id, loader);
      },
    });

    registry.preload("a", loader);
    await tick();
    await tick();

    expect(loader).toHaveBeenCalledTimes(1);
    expect(await nested).toBe("v");
    expect(registry.get("a")).toBe("v");
  });

  it("a DIFFERENT key loaded from onLoadStart runs independently", async () => {
    let registry!: ReturnType<typeof createChunkRegistry>;
    let nested: Promise<unknown> | null = null;

    registry = createChunkRegistry({
      retries: 0,
      timeout: 0,
      onLoadStart: (id) => {
        if (id === "a") nested = registry.load("b", async () => "b-value");
      },
    });

    expect(await registry.load("a", async () => "a-value")).toBe("a-value");
    expect(await nested).toBe("b-value");
    expect(registry.get("a")).toBe("a-value");
    expect(registry.get("b")).toBe("b-value");
    expect(registry.stats()).toEqual({ ...EMPTY, size: 2 });
  });
});

describe("callback and loader failures during reentrant sequences", () => {
  it("a throwing onLoadStart that also invalidates still loads and still suppresses publication", async () => {
    let registry!: ReturnType<typeof createChunkRegistry>;
    const reported: Array<{ name?: string }> = [];
    setRuntimeErrorHandler((_e, ctx) => reported.push({ name: ctx.name }));

    const loader = vi.fn(async () => "stale");
    registry = createChunkRegistry({
      retries: 0,
      timeout: 0,
      onLoadStart: (id) => {
        registry.invalidate(id);
        throw new Error("observer failed");
      },
    });

    await expect(registry.load("a", loader)).resolves.toBe("stale");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(registry.has("a")).toBe(false);
    expect(reported).toEqual([{ name: "chunkRegistry(onLoadStart)" }]);
  });

  it("a synchronous loader throw rejects the caller and leaves no pending entry", async () => {
    const registry = createChunkRegistry({ retries: 0, timeout: 0 });
    const boom = new Error("sync loader throw");

    const result = await settle(
      registry.load("a", () => {
        throw boom;
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(boom);
    expect(registry.stats()).toEqual(EMPTY);

    // …and the key is still loadable afterwards.
    expect(await registry.load("a", async () => "second try")).toBe("second try");
  });

  it("a synchronous loader throw inside a reentrant sequence is contained", async () => {
    let registry!: ReturnType<typeof createChunkRegistry>;
    let nested: Promise<unknown> | null = null;
    const boom = new Error("sync loader throw");

    registry = createChunkRegistry({
      retries: 0,
      timeout: 0,
      onLoadStart: (id) => {
        nested = registry.load(id, async () => "never used");
      },
    });

    const result = await settle(
      registry.load("a", () => {
        throw boom;
      }),
    );
    const nestedResult = await settle(nested as unknown as Promise<unknown>);

    // The nested call shares the operation, so it sees the same failure.
    expect(result.ok).toBe(false);
    expect(nestedResult.ok).toBe(false);
    expect(nestedResult.ok === false && nestedResult.error).toBe(boom);
    expect(registry.stats()).toEqual(EMPTY);
  });

  it("no unhandled rejection escapes any reentrant path", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    setRuntimeErrorHandler(() => {});
    try {
      let registry!: ReturnType<typeof createChunkRegistry>;
      registry = createChunkRegistry({
        retries: 0,
        timeout: 0,
        onLoadStart: (id) => {
          registry.invalidate(id);
          throw new Error("start observer failed");
        },
        onLoadEnd: () => {
          throw new Error("end observer failed");
        },
        onLoadError: () => {
          throw new Error("error observer failed");
        },
      });

      // A preload nobody awaits, whose loader fails after a reentrant invalidation.
      registry.preload("bad", () => Promise.reject(new Error("loader failed")));
      registry.preload("ok", async () => "v");
      await tick();
      await tick();
      await tick();

      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
