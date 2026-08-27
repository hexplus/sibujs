/**
 * `wasm()` runs must be latest-wins.
 *
 * The keyed cache underneath is generationally correct, but the reactive
 * wrapper is a separate owner: it publishes `instance` / `error` / `loading`
 * from whichever run happens to settle last, not from the newest one. With an
 * unkeyed `ArrayBuffer` / `Uint8Array` source — documented to instantiate fresh
 * every call rather than share an in-flight operation — two runs genuinely
 * overlap, and a slow automatic load can land after a `reload()` and overwrite
 * it.
 *
 * The failure is silent and wrong in both directions: a stale success can
 * replace a newer instance, and a stale failure can raise an error for a load
 * that actually succeeded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWasmCache, wasm } from "../src/platform/wasm";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Attached at creation so a rejection used by a test never escapes as an
  // unhandled rejection while the test is still setting up.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Gates each `WebAssembly.instantiate` call so runs can be settled by hand. */
let gates: ReturnType<typeof deferred<unknown>>[];

beforeEach(() => {
  clearWasmCache();
  gates = [];
  (globalThis as Record<string, unknown>).WebAssembly = {
    compile: vi.fn(async () => ({}) as unknown as WebAssembly.Module),
    instantiate: vi.fn(() => {
      const d = deferred<unknown>();
      gates.push(d);
      return d.promise;
    }),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  clearWasmCache();
});

const settleRun = (i: number, tag: string) => gates[i]?.resolve({ exports: { tag } });
const failRun = (i: number, message: string) => gates[i]?.reject(new Error(message));

describe("wasm() — latest run owns the reactive state", () => {
  it("a late-succeeding stale run cannot overwrite a newer success", async () => {
    // Unkeyed source: each run instantiates its own module, so A and B overlap.
    const state = wasm(new ArrayBuffer(8));
    await flush(); // run A reaches instantiate

    const reloaded = state.reload();
    await flush(); // run B reaches instantiate

    settleRun(1, "B");
    await reloaded;
    await flush();

    expect((state.instance() as { tag: string } | null)?.tag).toBe("B");

    // A finishes afterwards — and must publish nothing.
    settleRun(0, "A");
    await flush();
    await flush();

    expect((state.instance() as { tag: string } | null)?.tag, "a stale run overwrote the newer instance").toBe("B");
    expect(state.error()).toBeNull();
    expect(state.loading()).toBe(false);
    expect(state.ready()).toBe(true);
  });

  it("a late-FAILING stale run cannot raise an error over a newer success", async () => {
    const state = wasm(new ArrayBuffer(8));
    await flush();

    const reloaded = state.reload();
    await flush();

    settleRun(1, "B");
    await reloaded;
    await flush();

    failRun(0, "stale failure");
    await flush();
    await flush();

    expect((state.instance() as { tag: string } | null)?.tag).toBe("B");
    expect(state.ready()).toBe(true);
    expect(state.error(), "a stale failure surfaced over a successful newer run").toBeNull();
    expect(state.loading()).toBe(false);
  });

  it("a late-SUCCEEDING stale run cannot clear a newer failure", async () => {
    const state = wasm(new ArrayBuffer(8));
    await flush();

    const reloaded = state.reload().catch(() => {});
    await flush();

    failRun(1, "newest failed");
    await reloaded;
    await flush();

    expect(state.error()?.message).toBe("newest failed");

    settleRun(0, "A");
    await flush();
    await flush();

    expect(state.error()?.message, "a stale success cleared the newer failure").toBe("newest failed");
    expect(state.instance(), "a stale run published its instance").toBeNull();
    expect(state.ready()).toBe(false);
    expect(state.loading()).toBe(false);
  });

  it("keeps loading() false once the newest run has settled", async () => {
    const state = wasm(new ArrayBuffer(8));
    await flush();

    const reloaded = state.reload();
    await flush();

    settleRun(1, "B");
    await reloaded;
    await flush();
    expect(state.loading()).toBe(false);

    // The stale run's `finally` must not re-raise or re-clear loading.
    settleRun(0, "A");
    await flush();
    expect(state.loading()).toBe(false);
  });
});

describe("wasm() — non-overlapping behaviour is unchanged", () => {
  it("publishes the initial load", async () => {
    const state = wasm(new ArrayBuffer(8));
    expect(state.loading()).toBe(true);
    await flush();

    settleRun(0, "first");
    await flush();

    expect((state.instance() as { tag: string } | null)?.tag).toBe("first");
    expect(state.ready()).toBe(true);
    expect(state.error()).toBeNull();
    expect(state.loading()).toBe(false);
  });

  it("publishes a sequential reload", async () => {
    const state = wasm(new ArrayBuffer(8));
    await flush();
    settleRun(0, "first");
    await flush();

    const reloaded = state.reload();
    await flush();
    settleRun(1, "second");
    await reloaded;
    await flush();

    expect((state.instance() as { tag: string } | null)?.tag).toBe("second");
    expect(state.error()).toBeNull();
    expect(state.loading()).toBe(false);
  });

  it("publishes a sequential failure", async () => {
    const state = wasm(new ArrayBuffer(8));
    await flush();
    settleRun(0, "first");
    await flush();

    const reloaded = state.reload();
    await flush();
    failRun(1, "boom");
    await reloaded;
    await flush();

    expect(state.error()?.message).toBe("boom");
    expect(state.instance()).toBeNull();
    expect(state.ready()).toBe(false);
    expect(state.loading()).toBe(false);
  });

  it("preserves reload()'s existing resolve contract", async () => {
    const state = wasm(new ArrayBuffer(8));
    await flush();
    settleRun(0, "first");
    await flush();

    const reloaded = state.reload();
    await flush();
    failRun(1, "boom");

    // reload() has always captured failures into `error()` rather than
    // rejecting; that contract is unchanged.
    await expect(reloaded).resolves.toBeUndefined();
  });
});
