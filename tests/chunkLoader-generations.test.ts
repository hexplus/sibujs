/**
 * `createChunkRegistry()` — invalidation as a publication barrier.
 *
 * WHAT WAS WRONG
 * --------------
 * `invalidate(id)` and `clear()` deleted cache entries and left the `pending`
 * map untouched, so an in-flight load that started *before* the invalidation
 * still ran its continuation afterwards:
 *
 *     load("a") starts → clear() → old load resolves → cache.set("a", stale)
 *
 * leaving `has("a") === true` holding data the caller had explicitly discarded.
 * The same continuation ran `pending.delete(id)` unconditionally, so a *newer*
 * pending entry for the same id was removed by its predecessor's settlement.
 * And since the stale promise stayed in `pending`, a `load(id, freshLoader)`
 * issued after the invalidation deduplicated against it — the new loader was
 * never invoked and the caller received the stale value.
 *
 * The barrier is ownership by identity: the entry object installed in `pending`
 * IS the load's claim on the key, so removing it revokes the claim. A load only
 * publishes or cleans up when it finds its own entry still installed.
 *
 * Nothing is cancelled — the loader API takes no abort signal — so these tests
 * assert only what is actually true: superseded work still settles for its own
 * caller, and cannot touch shared state.
 */

import { describe, expect, it, vi } from "vitest";
import { createChunkRegistry } from "../src/performance/chunkLoader";
import { createDeferred } from "./helpers/mocks";

/** A deferred whose rejection is always handled, so tests never leak one. */
function gate<T = void>() {
  const d = createDeferred<T>();
  d.promise.catch(() => {});
  return d;
}

/** Attach handlers synchronously; never let an expected rejection escape. */
function settle<T>(p: Promise<T>) {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("chunk registry — invalidate() is a barrier", () => {
  it("1. pending load → invalidate(id) → old success cannot repopulate", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const d = gate<string>();
    const p = settle(registry.load("a", () => d.promise));

    registry.invalidate("a");
    d.resolve("stale");

    // The original caller still gets its value…
    expect(await p).toEqual({ ok: true, value: "stale" });
    // …but the discarded key stays discarded.
    expect(registry.has("a")).toBe(false);
    expect(registry.get("a")).toBeUndefined();
    expect(registry.stats()).toEqual({ size: 0, maxSize: 50, pending: 0, preloaded: 0 });
  });

  it("2. pending load → invalidate(id) → old failure cannot corrupt state", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const d = gate<string>();
    const p = settle(registry.load("a", () => d.promise));

    registry.invalidate("a");
    const boom = new Error("late failure");
    d.reject(boom);

    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(boom);
    expect(registry.stats()).toEqual({ size: 0, maxSize: 50, pending: 0, preloaded: 0 });
  });

  it("3. pending load → clear() → old success cannot repopulate", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const d = gate<string>();
    const p = settle(registry.load("a", () => d.promise));

    registry.clear();
    d.resolve("stale");

    expect(await p).toEqual({ ok: true, value: "stale" });
    expect(registry.has("a")).toBe(false);
    expect(registry.stats()).toEqual({ size: 0, maxSize: 50, pending: 0, preloaded: 0 });
  });

  it("4. pending load → clear() → old failure cannot corrupt state", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const d = gate<string>();
    const p = settle(registry.load("a", () => d.promise));

    registry.clear();
    d.reject(new Error("late failure"));

    expect((await p).ok).toBe(false);
    expect(registry.stats()).toEqual({ size: 0, maxSize: 50, pending: 0, preloaded: 0 });
  });

  it("clear() supersedes every key at once", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const a = gate<string>();
    const b = gate<string>();
    const pa = settle(registry.load("a", () => a.promise));
    const pb = settle(registry.load("b", () => b.promise));
    expect(registry.stats().pending).toBe(2);

    registry.clear();
    expect(registry.stats().pending).toBe(0);

    a.resolve("a!");
    b.resolve("b!");
    await pa;
    await pb;
    expect(registry.stats()).toEqual({ size: 0, maxSize: 50, pending: 0, preloaded: 0 });
  });
});

describe("chunk registry — superseded work vs newer work", () => {
  it("5. A pending → invalidate → B success → A succeeds late", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const a = gate<string>();
    const b = gate<string>();

    const pa = settle(registry.load("a", () => a.promise));
    registry.invalidate("a");
    const pb = settle(registry.load("a", () => b.promise));

    b.resolve("fresh");
    expect(await pb).toEqual({ ok: true, value: "fresh" });
    expect(registry.get("a")).toBe("fresh");

    a.resolve("stale");
    expect(await pa).toEqual({ ok: true, value: "stale" });
    // The stale success must not overwrite the newer cached result.
    expect(registry.get("a")).toBe("fresh");
    expect(registry.stats()).toEqual({ size: 1, maxSize: 50, pending: 0, preloaded: 0 });
  });

  it("6. A pending → invalidate → B success → A fails late", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const a = gate<string>();
    const b = gate<string>();

    const pa = settle(registry.load("a", () => a.promise));
    registry.invalidate("a");
    const pb = settle(registry.load("a", () => b.promise));

    b.resolve("fresh");
    await pb;
    a.reject(new Error("stale failure"));
    expect((await pa).ok).toBe(false);

    // A stale failure must not remove or corrupt the newer cached result.
    expect(registry.get("a")).toBe("fresh");
    expect(registry.stats()).toEqual({ size: 1, maxSize: 50, pending: 0, preloaded: 0 });
  });

  it("7. A pending → clear → B failure → A succeeds late", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const a = gate<string>();
    const b = gate<string>();

    const pa = settle(registry.load("a", () => a.promise));
    registry.clear();
    const pb = settle(registry.load("a", () => b.promise));

    b.reject(new Error("B failed"));
    expect((await pb).ok).toBe(false);
    expect(registry.stats().pending).toBe(0);

    a.resolve("stale");
    expect(await pa).toEqual({ ok: true, value: "stale" });
    // Neither the failed newer load nor the superseded older one leaves a value.
    expect(registry.has("a")).toBe(false);
    expect(registry.stats()).toEqual({ size: 0, maxSize: 50, pending: 0, preloaded: 0 });
  });

  it("8. a post-invalidation load invokes the NEW loader", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const first = gate<string>();
    const secondLoader = vi.fn(async () => "fresh");

    const p1 = settle(registry.load("a", () => first.promise));
    registry.invalidate("a");
    const p2 = settle(registry.load("a", secondLoader));

    first.resolve("stale");
    expect(await p1).toEqual({ ok: true, value: "stale" });
    expect(await p2).toEqual({ ok: true, value: "fresh" });
    expect(secondLoader).toHaveBeenCalledTimes(1);
    expect(registry.get("a")).toBe("fresh");
  });

  it("9. two same-generation callers still deduplicate", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const d = gate<string>();
    const loader = vi.fn(() => d.promise);

    const p1 = settle(registry.load("a", loader));
    const p2 = settle(registry.load("a", loader));
    expect(registry.stats().pending).toBe(1);

    d.resolve("v");
    expect(await p1).toEqual({ ok: true, value: "v" });
    expect(await p2).toEqual({ ok: true, value: "v" });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(registry.stats()).toEqual({ size: 1, maxSize: 50, pending: 0, preloaded: 0 });
  });

  it("10. stale settlement does not delete the newer pending entry", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const first = gate<string>();
    const second = gate<string>();

    const p1 = settle(registry.load("a", () => first.promise));
    registry.invalidate("a");
    const p2 = settle(registry.load("a", () => second.promise));
    expect(registry.stats().pending).toBe(1);

    first.resolve("stale");
    await p1;
    await tick();
    // The newer load is still owned and still in flight.
    expect(registry.stats().pending).toBe(1);

    second.resolve("fresh");
    await p2;
    expect(registry.get("a")).toBe("fresh");
    expect(registry.stats()).toEqual({ size: 1, maxSize: 50, pending: 0, preloaded: 0 });
  });

  it("a failed load remains retryable", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const first = gate<string>();
    const p1 = settle(registry.load("a", () => first.promise));
    first.reject(new Error("nope"));
    expect((await p1).ok).toBe(false);
    expect(registry.stats().pending).toBe(0);

    const p2 = settle(registry.load("a", async () => "second try"));
    expect(await p2).toEqual({ ok: true, value: "second try" });
    expect(registry.get("a")).toBe("second try");
  });
});

describe("chunk registry — preload follows the same rules", () => {
  it("11. a stale preload cannot repopulate the cache", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const d = gate<string>();
    registry.preload("a", () => d.promise);
    expect(registry.stats().pending).toBe(1);
    expect(registry.stats().preloaded).toBe(1);

    registry.clear();
    d.resolve("stale");
    await tick();

    expect(registry.has("a")).toBe(false);
    expect(registry.stats()).toEqual({ size: 0, maxSize: 50, pending: 0, preloaded: 0 });
  });

  it("12. preload can be requested again after invalidation", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const first = gate<string>();
    const secondLoader = vi.fn(async () => "fresh");

    registry.preload("a", () => first.promise);
    registry.invalidate("a");
    registry.preload("a", secondLoader);

    first.resolve("stale");
    await tick();
    await tick();

    expect(secondLoader).toHaveBeenCalledTimes(1);
    expect(registry.get("a")).toBe("fresh");
  });

  it("a stale preload failure does not cancel a newer preload's guard", async () => {
    // The old code's `.catch(() => preloaded.delete(id))` was unconditional, so
    // a superseded preload's late failure removed the marker a NEWER preload had
    // installed — after which a third preload would start redundant work.
    const registry = createChunkRegistry({ retries: 0 });
    const first = gate<string>();
    const second = gate<string>();

    registry.preload("a", () => first.promise);
    registry.invalidate("a");
    registry.preload("a", () => second.promise);
    expect(registry.stats().preloaded).toBe(1);

    first.reject(new Error("stale failure"));
    await tick();
    await tick();

    // The newer preload's marker survives its predecessor's failure.
    expect(registry.stats().preloaded).toBe(1);
    expect(registry.stats().pending).toBe(1);

    second.resolve("fresh");
    await tick();
    expect(registry.get("a")).toBe("fresh");
  });

  it("preloadAll follows the same generation rules", async () => {
    const registry = createChunkRegistry({ retries: 0 });
    const a = gate<string>();
    const b = gate<string>();
    registry.preloadAll([
      { id: "a", loader: () => a.promise },
      { id: "b", loader: () => b.promise },
    ]);
    expect(registry.stats().pending).toBe(2);

    registry.invalidate("a");
    a.resolve("stale-a");
    b.resolve("b!");
    await tick();
    await tick();

    expect(registry.has("a")).toBe(false);
    expect(registry.get("b")).toBe("b!");
    expect(registry.stats()).toEqual({ size: 1, maxSize: 50, pending: 0, preloaded: 1 });
  });

  it("lifecycle callbacks still fire for a superseded load", async () => {
    // Deliberate and pinned: a superseded load genuinely ran and genuinely
    // finished, and its caller receives the result — so silencing its observers
    // would hide real work from diagnostics. What it must NOT do is publish, and
    // the state assertions below are what enforce that.
    const events: string[] = [];
    const registry = createChunkRegistry({
      retries: 0,
      onLoadStart: (id) => events.push(`start:${id}`),
      onLoadEnd: (id) => events.push(`end:${id}`),
      onLoadError: (id) => events.push(`error:${id}`),
    });

    const d = gate<string>();
    const p = settle(registry.load("a", () => d.promise));
    registry.invalidate("a");
    d.resolve("stale");
    await p;

    expect(events).toEqual(["start:a", "end:a"]);
    expect(registry.has("a")).toBe(false);
    expect(registry.stats()).toEqual({ size: 0, maxSize: 50, pending: 0, preloaded: 0 });
  });

  it("13. no expected rejection escapes as an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent | unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const registry = createChunkRegistry({ retries: 0 });
      const a = gate<string>();
      const b = gate<string>();

      // A preload whose failure nobody awaits, superseded mid-flight.
      registry.preload("a", () => a.promise);
      registry.invalidate("a");
      a.reject(new Error("unobserved stale preload failure"));

      // A load whose rejection IS observed.
      const p = settle(registry.load("b", () => b.promise));
      b.reject(new Error("observed"));
      expect((await p).ok).toBe(false);

      await tick();
      await tick();
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
