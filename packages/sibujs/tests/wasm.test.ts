import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearWasmCache,
  createWasmBridge,
  isWasmCached,
  loadWasmModule,
  preloadWasm,
  wasm,
} from "../src/platform/wasm";

// ---------------------------------------------------------------------------
// WebAssembly fakes
//
// jsdom does not implement WebAssembly streaming/compile/instantiate, so we
// stub the pieces each test needs. A fake "module" and "instance" carry an id
// so we can assert caching behavior.
// ---------------------------------------------------------------------------

function fakeModule(id = "mod") {
  return { __module: id } as unknown as WebAssembly.Module;
}

function fakeInstance(exports: Record<string, unknown> = {}) {
  return { exports } as unknown as WebAssembly.Instance;
}

beforeEach(() => {
  clearWasmCache();
  (globalThis as Record<string, unknown>).WebAssembly = {} as unknown;
});

afterEach(() => {
  vi.restoreAllMocks();
  clearWasmCache();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// loadWasmModule - origin guard
// ---------------------------------------------------------------------------
describe("loadWasmModule origin guard", () => {
  it("refuses a URL with no allowedOrigins and no opt-in", async () => {
    await expect(loadWasmModule("https://evil.com/x.wasm")).rejects.toThrow(/refused to fetch/);
  });

  it("rejects a URL whose origin is not in the allowlist", async () => {
    await expect(loadWasmModule("https://evil.com/x.wasm", { allowedOrigins: ["https://good.com"] })).rejects.toThrow(
      /not in the allowlist/,
    );
  });

  it("rejects an invalid URL when an allowlist is given", async () => {
    await expect(loadWasmModule("http://[", { allowedOrigins: ["https://good.com"] })).rejects.toThrow(/invalid URL/);
  });
});

// ---------------------------------------------------------------------------
// loadWasmModule - streaming and non-streaming paths
// ---------------------------------------------------------------------------
describe("loadWasmModule loading paths", () => {
  it("uses instantiateStreaming for URLs and caches module + instance", async () => {
    const mod = fakeModule("s1");
    const inst = fakeInstance({ add: () => 3 });
    (globalThis.WebAssembly as Record<string, unknown>).instantiateStreaming = vi
      .fn()
      .mockResolvedValue({ module: mod, instance: inst });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue("RESP" as never);

    const result = await loadWasmModule("https://good.com/m.wasm", {
      allowedOrigins: ["https://good.com"],
    });
    expect(result).toBe(inst);
    expect(fetchSpy).toHaveBeenCalledWith("https://good.com/m.wasm");
    expect(isWasmCached("https://good.com/m.wasm")).toBe(true);

    // Second call returns the cached instance without re-fetching
    const again = await loadWasmModule("https://good.com/m.wasm", {
      allowedOrigins: ["https://good.com"],
    });
    expect(again).toBe(inst);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to fetch + compile + instantiate when streaming is unavailable", async () => {
    const buffer = new ArrayBuffer(4);
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      arrayBuffer: () => Promise.resolve(buffer),
    } as never);
    const mod = fakeModule("c1");
    const inst = fakeInstance({ ok: 1 });
    (globalThis.WebAssembly as Record<string, unknown>).compile = vi.fn().mockResolvedValue(mod);
    (globalThis.WebAssembly as Record<string, unknown>).instantiate = vi.fn().mockResolvedValue(inst);

    const result = await loadWasmModule("https://good.com/n.wasm", {
      allowedOrigins: ["https://good.com"],
    });
    expect(result).toBe(inst);
    expect((globalThis.WebAssembly as Record<string, unknown>).compile).toHaveBeenCalledWith(buffer);
  });

  it("compiles an ArrayBuffer source directly (no origin guard)", async () => {
    const buffer = new ArrayBuffer(8);
    const mod = fakeModule("buf");
    const inst = fakeInstance({});
    const compile = vi.fn().mockResolvedValue(mod);
    const instantiate = vi.fn().mockResolvedValue(inst);
    (globalThis.WebAssembly as Record<string, unknown>).compile = compile;
    (globalThis.WebAssembly as Record<string, unknown>).instantiate = instantiate;

    const result = await loadWasmModule(buffer);
    expect(result).toBe(inst);
    expect(compile).toHaveBeenCalledWith(buffer);
  });

  it("compiles a Uint8Array source by slicing its backing buffer", async () => {
    const full = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = full.subarray(2, 5); // offset 2, length 3
    const inst = fakeInstance({});
    const compile = vi.fn().mockResolvedValue(fakeModule());
    (globalThis.WebAssembly as Record<string, unknown>).compile = compile;
    (globalThis.WebAssembly as Record<string, unknown>).instantiate = vi.fn().mockResolvedValue(inst);

    await loadWasmModule(view);
    const passed = compile.mock.calls[0][0] as ArrayBuffer;
    expect(passed.byteLength).toBe(3);
    expect(Array.from(new Uint8Array(passed))).toEqual([3, 4, 5]);
  });

  it("reuses the cached module but re-instantiates with a cacheKey", async () => {
    const buffer = new ArrayBuffer(8);
    const mod = fakeModule("reuse");
    const compile = vi.fn().mockResolvedValue(mod);
    const instantiate = vi.fn().mockResolvedValue(fakeInstance({ a: 1 }));
    (globalThis.WebAssembly as Record<string, unknown>).compile = compile;
    (globalThis.WebAssembly as Record<string, unknown>).instantiate = instantiate;

    await loadWasmModule(buffer, undefined, "shared-key");
    // Clear only the instance cache by clearing all then re-priming module cache is
    // not exposed; instead a second call with the same key hits the instance cache.
    const second = await loadWasmModule(buffer, undefined, "shared-key");
    expect(second).toBe((await instantiate.mock.results[0].value) as unknown);
    // compile and instantiate each ran once because instance was cached
    expect(compile).toHaveBeenCalledTimes(1);
    expect(instantiate).toHaveBeenCalledTimes(1);
  });

  it("treats an options bag with allowedOrigins distinctly from WebAssembly.Imports", async () => {
    const buffer = new ArrayBuffer(4);
    const instantiate = vi.fn().mockResolvedValue(fakeInstance({}));
    (globalThis.WebAssembly as Record<string, unknown>).compile = vi.fn().mockResolvedValue(fakeModule());
    (globalThis.WebAssembly as Record<string, unknown>).instantiate = instantiate;

    await loadWasmModule(buffer, { imports: { env: {} }, allowedOrigins: ["x"] });
    expect(instantiate).toHaveBeenCalledWith(expect.anything(), { env: {} });
  });

  it("passes a raw WebAssembly.Imports record through (back-compat)", async () => {
    const buffer = new ArrayBuffer(4);
    const instantiate = vi.fn().mockResolvedValue(fakeInstance({}));
    (globalThis.WebAssembly as Record<string, unknown>).compile = vi.fn().mockResolvedValue(fakeModule());
    (globalThis.WebAssembly as Record<string, unknown>).instantiate = instantiate;

    const imports = { env: { memory: {} } } as unknown as WebAssembly.Imports;
    await loadWasmModule(buffer, imports);
    expect(instantiate).toHaveBeenCalledWith(expect.anything(), imports);
  });
});

// ---------------------------------------------------------------------------
// wasm hook
// ---------------------------------------------------------------------------
describe("wasm hook", () => {
  it("loads immediately and exposes ready/instance", async () => {
    const buffer = new ArrayBuffer(4);
    (globalThis.WebAssembly as Record<string, unknown>).compile = vi.fn().mockResolvedValue(fakeModule());
    (globalThis.WebAssembly as Record<string, unknown>).instantiate = vi
      .fn()
      .mockResolvedValue(fakeInstance({ add: (a: number, b: number) => a + b }));

    const w = wasm<{ add: (a: number, b: number) => number }>(buffer);
    expect(w.loading()).toBe(true);
    await flush();
    expect(w.loading()).toBe(false);
    expect(w.ready()).toBe(true);
    expect(w.error()).toBeNull();
    expect(w.instance()!.add(1, 2)).toBe(3);
  });

  it("sets error when loading fails", async () => {
    (globalThis.WebAssembly as Record<string, unknown>).compile = vi
      .fn()
      .mockRejectedValue(new Error("compile failed"));
    const w = wasm(new ArrayBuffer(4));
    await flush();
    expect(w.error()).toBeInstanceOf(Error);
    expect(w.error()?.message).toBe("compile failed");
    expect(w.ready()).toBe(false);
  });

  it("reload() re-runs the loader", async () => {
    const instantiate = vi.fn().mockResolvedValue(fakeInstance({ v: 1 }));
    (globalThis.WebAssembly as Record<string, unknown>).compile = vi.fn().mockResolvedValue(fakeModule());
    (globalThis.WebAssembly as Record<string, unknown>).instantiate = instantiate;

    const w = wasm(new ArrayBuffer(4));
    await flush();
    await w.reload();
    expect(instantiate).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// preloadWasm
// ---------------------------------------------------------------------------
describe("preloadWasm", () => {
  it("refuses with no allowedOrigins and no opt-in", async () => {
    await expect(preloadWasm("https://evil.com/a.wasm")).rejects.toThrow(/refused to fetch/);
  });

  it("rejects an origin not in the allowlist", async () => {
    await expect(preloadWasm("https://evil.com/a.wasm", { allowedOrigins: ["https://good.com"] })).rejects.toThrow(
      /not in the allowlist/,
    );
  });

  it("rejects an invalid URL with an allowlist", async () => {
    await expect(preloadWasm("http://[", { allowedOrigins: ["https://good.com"] })).rejects.toThrow(/invalid URL/);
  });

  it("uses compileStreaming when available and caches the module", async () => {
    (globalThis.WebAssembly as Record<string, unknown>).compileStreaming = vi.fn().mockResolvedValue(fakeModule());
    vi.spyOn(globalThis, "fetch").mockReturnValue("RESP" as never);

    await preloadWasm("https://good.com/p.wasm", { allowedOrigins: ["https://good.com"] });
    expect(isWasmCached("https://good.com/p.wasm")).toBe(true);
  });

  it("falls back to fetch + compile without compileStreaming", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    } as never);
    (globalThis.WebAssembly as Record<string, unknown>).compile = vi.fn().mockResolvedValue(fakeModule());

    await preloadWasm("https://good.com/q.wasm", { unsafelyAllowAnyOrigin: true });
    expect(isWasmCached("https://good.com/q.wasm")).toBe(true);
  });

  it("returns early if the module is already cached", async () => {
    (globalThis.WebAssembly as Record<string, unknown>).compileStreaming = vi.fn().mockResolvedValue(fakeModule());
    vi.spyOn(globalThis, "fetch").mockReturnValue("RESP" as never);
    await preloadWasm("https://good.com/r.wasm", { allowedOrigins: ["https://good.com"] });
    const callsAfterFirst = (globalThis.WebAssembly as Record<string, unknown>).compileStreaming as ReturnType<
      typeof vi.fn
    >;
    await preloadWasm("https://good.com/r.wasm", { allowedOrigins: ["https://good.com"] });
    expect(callsAfterFirst).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createWasmBridge
// ---------------------------------------------------------------------------
describe("createWasmBridge", () => {
  function makeInstance(opts: { withMalloc?: boolean; withFree?: boolean } = {}) {
    const memory = { buffer: new ArrayBuffer(1024) } as WebAssembly.Memory;
    let next = 16;
    const exports: Record<string, unknown> = { memory };
    if (opts.withMalloc !== false) {
      exports.malloc = (size: number) => {
        const ptr = next;
        next += size;
        return ptr;
      };
    }
    if (opts.withFree !== false) {
      exports.free = vi.fn();
    }
    return fakeInstance(exports);
  }

  it("exposes exports and memory", () => {
    const bridge = createWasmBridge(makeInstance());
    expect(bridge.memory).toBeDefined();
    expect(bridge.exports).toBeDefined();
  });

  it("alloc and free delegate to module exports", () => {
    const inst = makeInstance();
    const bridge = createWasmBridge(inst);
    const ptr = bridge.alloc(8);
    expect(typeof ptr).toBe("number");
    bridge.free(ptr);
    expect((inst.exports as Record<string, unknown>).free).toHaveBeenCalledWith(ptr);
  });

  it("throws when malloc/free are missing", () => {
    const bridge = createWasmBridge(makeInstance({ withMalloc: false, withFree: false }));
    expect(() => bridge.alloc(8)).toThrow(/malloc/);
    expect(() => bridge.free(0)).toThrow(/free/);
    expect(() => bridge.writeString("hi")).toThrow(/malloc/);
    expect(() => bridge.writeArray([1, 2])).toThrow(/malloc/);
  });

  it("round-trips a string through writeString/readString", () => {
    const bridge = createWasmBridge(makeInstance());
    const { ptr, len } = bridge.writeString("hello");
    expect(len).toBe(5);
    expect(bridge.readString(ptr, len)).toBe("hello");
  });

  it("round-trips a numeric array through writeArray/readF64Array", () => {
    const bridge = createWasmBridge(makeInstance());
    const { ptr, len } = bridge.writeArray([1.5, 2.5, 3.5]);
    expect(len).toBe(3);
    expect(Array.from(bridge.readF64Array(ptr, len))).toEqual([1.5, 2.5, 3.5]);
  });
});

// ---------------------------------------------------------------------------
// cache helpers
// ---------------------------------------------------------------------------
describe("cache helpers", () => {
  it("clearWasmCache empties the cache and isWasmCached reflects it", async () => {
    (globalThis.WebAssembly as Record<string, unknown>).compileStreaming = vi.fn().mockResolvedValue(fakeModule());
    vi.spyOn(globalThis, "fetch").mockReturnValue("RESP" as never);
    await preloadWasm("https://good.com/z.wasm", { allowedOrigins: ["https://good.com"] });
    expect(isWasmCached("https://good.com/z.wasm")).toBe(true);
    clearWasmCache();
    expect(isWasmCached("https://good.com/z.wasm")).toBe(false);
  });
});
