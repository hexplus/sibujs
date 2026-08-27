/**
 * WASM public-wrapper parity + singleton concurrency.
 *
 * INVARIANT (wrapper parity): `wasm()` is the public convenience wrapper over
 * `loadWasmModule()`. The primitive REQUIRES an explicit origin policy for URL
 * sources, so the wrapper must be able to express one — otherwise the safe API
 * is simply unusable from the public surface.
 *
 * INVARIANT (concurrency): a keyed load is documented as a singleton instance.
 * Concurrent callers for one key must share a single in-flight instantiation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWasmCache, loadWasmModuleWithOptions, wasm } from "../src/platform/wasm";

function fakeModule(id = "mod") {
  return { __module: id } as unknown as WebAssembly.Module;
}

function fakeInstance(exports: Record<string, unknown> = {}) {
  return { exports } as unknown as WebAssembly.Instance;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  clearWasmCache();
  (globalThis as Record<string, unknown>).WebAssembly = {} as unknown;
});

afterEach(() => {
  vi.restoreAllMocks();
  clearWasmCache();
});

describe("wasm() wrapper — origin policy parity", () => {
  it("refuses a URL source with no origin policy, matching the primitive", async () => {
    const state = wasm("https://cdn.example.com/math.wasm");
    await flush();
    expect(state.error()).toBeInstanceOf(Error);
    expect(state.error()?.message).toMatch(/refused to fetch/);
    expect(state.ready()).toBe(false);
  });

  it("loads a URL source when allowedOrigins is supplied through the wrapper", async () => {
    const instance = fakeInstance({ add: () => 3 });
    (globalThis as Record<string, unknown>).WebAssembly = {
      compile: vi.fn(async () => fakeModule()),
      instantiate: vi.fn(async () => instance),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
    );

    const state = wasm("https://cdn.example.com/math.wasm", {
      allowedOrigins: ["https://cdn.example.com"],
    });
    await flush();

    expect(state.error()).toBeNull();
    expect(state.ready()).toBe(true);
  });

  it("rejects a URL whose origin is outside the wrapper's allowlist", async () => {
    const state = wasm("https://evil.example.com/x.wasm", {
      allowedOrigins: ["https://cdn.example.com"],
    });
    await flush();

    expect(state.error()?.message).toMatch(/not in the allowlist/);
  });

  it("loads a URL source under an explicit unsafe opt-in through the wrapper", async () => {
    const instance = fakeInstance({ ok: true });
    (globalThis as Record<string, unknown>).WebAssembly = {
      compile: vi.fn(async () => fakeModule()),
      instantiate: vi.fn(async () => instance),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
    );

    const state = wasm("https://anywhere.example/x.wasm", { unsafelyAllowAnyOrigin: true });
    await flush();

    expect(state.error()).toBeNull();
    expect(state.ready()).toBe(true);
  });

  it("still loads an ArrayBuffer source with no origin policy", async () => {
    const instance = fakeInstance({ ok: true });
    (globalThis as Record<string, unknown>).WebAssembly = {
      compile: vi.fn(async () => fakeModule()),
      instantiate: vi.fn(async () => instance),
    };

    const state = wasm(new ArrayBuffer(8));
    await flush();

    expect(state.error()).toBeNull();
    expect(state.ready()).toBe(true);
  });

  it("still forwards imports and cacheKey", async () => {
    const instantiate = vi.fn(async () => fakeInstance({ ok: true }));
    (globalThis as Record<string, unknown>).WebAssembly = {
      compile: vi.fn(async () => fakeModule()),
      instantiate,
    };
    const imports = { env: { log: () => {} } };

    const state = wasm(new ArrayBuffer(8), { imports, cacheKey: "k1" });
    await flush();

    expect(state.ready()).toBe(true);
    expect(instantiate).toHaveBeenCalledWith(expect.anything(), imports);
  });
});

describe("loadWasmModule — concurrent singleton", () => {
  it("instantiates once for concurrent loads of the same key", async () => {
    let instantiations = 0;
    (globalThis as Record<string, unknown>).WebAssembly = {
      compile: vi.fn(async () => fakeModule()),
      instantiate: vi.fn(async () => {
        instantiations++;
        await new Promise((r) => setTimeout(r, 5));
        return fakeInstance({ n: instantiations });
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
    );

    const opts = { allowedOrigins: ["https://cdn.example.com"], cacheKey: "same" };
    const [a, b, c] = await Promise.all([
      loadWasmModuleWithOptions("https://cdn.example.com/a.wasm", opts),
      loadWasmModuleWithOptions("https://cdn.example.com/a.wasm", opts),
      loadWasmModuleWithOptions("https://cdn.example.com/a.wasm", opts),
    ]);

    expect(instantiations).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("instantiates once for concurrent streaming loads of the same key", async () => {
    let instantiations = 0;
    (globalThis as Record<string, unknown>).WebAssembly = {
      instantiateStreaming: vi.fn(async () => {
        instantiations++;
        await new Promise((r) => setTimeout(r, 5));
        return { module: fakeModule(), instance: fakeInstance({ n: instantiations }) };
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({})),
    );

    const opts = { allowedOrigins: ["https://cdn.example.com"], cacheKey: "streamed" };
    const [a, b] = await Promise.all([
      loadWasmModuleWithOptions("https://cdn.example.com/s.wasm", opts),
      loadWasmModuleWithOptions("https://cdn.example.com/s.wasm", opts),
    ]);

    expect(instantiations).toBe(1);
    expect(a).toBe(b);
  });

  it("keeps distinct keys independent", async () => {
    let instantiations = 0;
    (globalThis as Record<string, unknown>).WebAssembly = {
      compile: vi.fn(async () => fakeModule()),
      instantiate: vi.fn(async () => {
        instantiations++;
        return fakeInstance({ n: instantiations });
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
    );

    const base = { allowedOrigins: ["https://cdn.example.com"] };
    const [a, b] = await Promise.all([
      loadWasmModuleWithOptions("https://cdn.example.com/a.wasm", { ...base, cacheKey: "k-a" }),
      loadWasmModuleWithOptions("https://cdn.example.com/b.wasm", { ...base, cacheKey: "k-b" }),
    ]);

    expect(instantiations).toBe(2);
    expect(a).not.toBe(b);
  });

  it("does not poison the key when the first concurrent load rejects", async () => {
    let attempt = 0;
    (globalThis as Record<string, unknown>).WebAssembly = {
      compile: vi.fn(async () => fakeModule()),
      instantiate: vi.fn(async () => {
        attempt++;
        if (attempt === 1) throw new Error("instantiate failed");
        return fakeInstance({ ok: true });
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
    );

    const opts = { allowedOrigins: ["https://cdn.example.com"], cacheKey: "retry" };

    const [r1, r2] = await Promise.allSettled([
      loadWasmModuleWithOptions("https://cdn.example.com/r.wasm", opts),
      loadWasmModuleWithOptions("https://cdn.example.com/r.wasm", opts),
    ]);
    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("rejected");

    // A later retry must be able to succeed.
    const instance = await loadWasmModuleWithOptions("https://cdn.example.com/r.wasm", opts);
    expect(instance).toBeTruthy();
  });

  it("shares one in-flight load between the wrapper and the primitive", async () => {
    let instantiations = 0;
    (globalThis as Record<string, unknown>).WebAssembly = {
      compile: vi.fn(async () => fakeModule()),
      instantiate: vi.fn(async () => {
        instantiations++;
        await new Promise((r) => setTimeout(r, 5));
        return fakeInstance({ n: instantiations });
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
    );

    const opts = { allowedOrigins: ["https://cdn.example.com"], cacheKey: "shared" };
    const viaWrapper = wasm("https://cdn.example.com/w.wasm", opts);
    const viaPrimitive = loadWasmModuleWithOptions("https://cdn.example.com/w.wasm", opts);

    await viaPrimitive;
    await flush();
    await flush();

    expect(instantiations).toBe(1);
    expect(viaWrapper.ready()).toBe(true);
  });
});
