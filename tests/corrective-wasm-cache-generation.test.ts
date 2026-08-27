/**
 * `clearWasmCache()` must be an INVALIDATION BARRIER, not three `Map.clear()`
 * calls.
 *
 * Clearing the maps only erases what has already been written. A load that was
 * already in flight still holds references to those same global maps and writes
 * into them when it settles — so a caller that clears the cache to force a
 * fresh compile (a hot reload, a test between cases, a version bump) can have
 * the OLD module or instance reinstated moments later, by the very work it
 * invalidated. The cache then looks populated with pre-clear content.
 *
 * The barrier is generational: an operation may always resolve to the caller
 * that started it, but it may only publish into the generation it began in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWasmCache, isWasmCached, loadWasmModuleWithOptions, preloadWasm } from "../src/platform/wasm";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let compileCalls: number;
let instantiateCalls: number;

beforeEach(() => {
  clearWasmCache();
  compileCalls = 0;
  instantiateCalls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  clearWasmCache();
});

/** WebAssembly stub whose compile/instantiate can be released on demand. */
function stubWasm(opts: { streaming?: boolean } = {}) {
  const compileGate: Array<{ resolve: (v: WebAssembly.Module) => void }> = [];
  const settleGate: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];

  const impl: Record<string, unknown> = {
    compile: vi.fn(() => {
      compileCalls++;
      const d = deferred<WebAssembly.Module>();
      compileGate.push(d);
      return d.promise;
    }),
    instantiate: vi.fn(() => {
      instantiateCalls++;
      const d = deferred<unknown>();
      settleGate.push(d);
      return d.promise;
    }),
  };

  if (opts.streaming) {
    impl.instantiateStreaming = vi.fn(() => {
      compileCalls++;
      instantiateCalls++;
      const d = deferred<unknown>();
      settleGate.push(d);
      return d.promise;
    });
  }

  (globalThis as Record<string, unknown>).WebAssembly = impl;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
  );

  return {
    releaseCompile: (i = 0) => compileGate[i]?.resolve({ tag: `m${i}` } as unknown as WebAssembly.Module),
    releaseInstantiate: (i = 0, exports: Record<string, unknown> = {}) => settleGate[i]?.resolve({ exports }),
    releaseStreaming: (i = 0, exports: Record<string, unknown> = {}) =>
      settleGate[i]?.resolve({ module: { tag: `m${i}` }, instance: { exports } }),
    rejectInstantiate: (i = 0, err: unknown = new Error("instantiate failed")) => settleGate[i]?.reject(err),
  };
}

describe("clearWasmCache() is an invalidation barrier", () => {
  it("a load in flight across the clear does not repopulate the cache", async () => {
    const w = stubWasm();
    const bytes = new ArrayBuffer(8);

    const a = loadWasmModuleWithOptions(bytes, { cacheKey: "x" });
    await flush();

    clearWasmCache();

    w.releaseCompile(0);
    await flush();
    w.releaseInstantiate(0, { tag: "old" });
    await a;
    await flush();

    expect(isWasmCached("x"), "pre-clear load repopulated the module cache").toBe(false);
  });

  it("a subsequent load with the same key compiles and instantiates fresh", async () => {
    const w = stubWasm();
    const bytes = new ArrayBuffer(8);

    const a = loadWasmModuleWithOptions(bytes, { cacheKey: "x" });
    await flush();
    clearWasmCache();
    w.releaseCompile(0);
    await flush();
    w.releaseInstantiate(0, { tag: "old" });
    await a;
    await flush();

    const compilesBefore = compileCalls;
    const instantiatesBefore = instantiateCalls;

    const b = loadWasmModuleWithOptions(bytes, { cacheKey: "x" });
    await flush();
    w.releaseCompile(compilesBefore);
    await flush();
    w.releaseInstantiate(instantiatesBefore, { tag: "new" });
    const instance = await b;

    expect(compileCalls).toBe(compilesBefore + 1);
    expect(instantiateCalls).toBe(instantiatesBefore + 1);
    expect((instance.exports as Record<string, unknown>).tag).toBe("new");
  });

  it("only the post-clear generation may populate the cache", async () => {
    const w = stubWasm();
    const bytes = new ArrayBuffer(8);

    // A starts in the pre-clear generation.
    const a = loadWasmModuleWithOptions(bytes, { cacheKey: "k" });
    await flush();

    clearWasmCache();

    // B starts in the live generation, same key.
    const b = loadWasmModuleWithOptions(bytes, { cacheKey: "k" });
    await flush();

    w.releaseCompile(0);
    await flush();
    w.releaseInstantiate(0, { tag: "A" });
    const instanceA = await a;
    await flush();

    w.releaseCompile(1);
    await flush();
    w.releaseInstantiate(1, { tag: "B" });
    const instanceB = await b;
    await flush();

    // Both callers still receive their own result…
    expect((instanceA.exports as Record<string, unknown>).tag).toBe("A");
    expect((instanceB.exports as Record<string, unknown>).tag).toBe("B");

    // …but only the live generation is published.
    expect(isWasmCached("k")).toBe(true);
    const cached = await loadWasmModuleWithOptions(bytes, { cacheKey: "k" });
    expect((cached.exports as Record<string, unknown>).tag).toBe("B");
  });

  it("guards the streaming path module-cache write", async () => {
    const w = stubWasm({ streaming: true });

    const a = loadWasmModuleWithOptions("https://cdn.example.com/a.wasm", {
      allowedOrigins: ["https://cdn.example.com"],
      cacheKey: "s",
    });
    await flush();

    clearWasmCache();

    w.releaseStreaming(0, { tag: "old" });
    await a;
    await flush();

    expect(isWasmCached("s"), "streaming path repopulated the module cache").toBe(false);
  });

  it("guards the preloadWasm module-cache write", async () => {
    const gate = deferred<WebAssembly.Module>();
    (globalThis as Record<string, unknown>).WebAssembly = {
      compileStreaming: vi.fn(() => gate.promise),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
    );

    const p = preloadWasm("https://cdn.example.com/p.wasm", {
      allowedOrigins: ["https://cdn.example.com"],
    });
    await flush();

    clearWasmCache();

    gate.resolve({ tag: "pre" } as unknown as WebAssembly.Module);
    await p;
    await flush();

    expect(isWasmCached("https://cdn.example.com/p.wasm"), "preloadWasm repopulated after clear").toBe(false);
  });

  it("an old-generation failure leaves the new generation in-flight entry alone", async () => {
    const w = stubWasm();
    const bytes = new ArrayBuffer(8);

    const a = loadWasmModuleWithOptions(bytes, { cacheKey: "k" }).catch(() => "A-failed");
    await flush();

    clearWasmCache();

    const b = loadWasmModuleWithOptions(bytes, { cacheKey: "k" });
    await flush();

    w.releaseCompile(0);
    await flush();
    w.rejectInstantiate(0, new Error("old generation failed"));
    expect(await a).toBe("A-failed");
    await flush();

    w.releaseCompile(1);
    await flush();
    w.releaseInstantiate(1, { tag: "B" });
    const instanceB = await b;

    expect((instanceB.exports as Record<string, unknown>).tag).toBe("B");
    expect(isWasmCached("k")).toBe(true);
  });
});

describe("normal singleton behaviour is unchanged without a clear", () => {
  it("shares one instantiation across concurrent loads of a key", async () => {
    const w = stubWasm();
    const bytes = new ArrayBuffer(8);

    const all = Promise.all([
      loadWasmModuleWithOptions(bytes, { cacheKey: "same" }),
      loadWasmModuleWithOptions(bytes, { cacheKey: "same" }),
      loadWasmModuleWithOptions(bytes, { cacheKey: "same" }),
    ]);
    await flush();
    w.releaseCompile(0);
    await flush();
    w.releaseInstantiate(0, { tag: "one" });

    const [x, y, z] = await all;
    expect(instantiateCalls).toBe(1);
    expect(x).toBe(y);
    expect(y).toBe(z);
  });

  it("serves a later load from the cache without recompiling", async () => {
    const w = stubWasm();
    const bytes = new ArrayBuffer(8);

    const first = loadWasmModuleWithOptions(bytes, { cacheKey: "warm" });
    await flush();
    w.releaseCompile(0);
    await flush();
    w.releaseInstantiate(0, { tag: "warm" });
    const a = await first;

    const b = await loadWasmModuleWithOptions(bytes, { cacheKey: "warm" });
    expect(b).toBe(a);
    expect(instantiateCalls).toBe(1);
  });
});
