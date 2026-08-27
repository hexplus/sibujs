/**
 * `loadWasmModule()` public API shape.
 *
 * The second parameter was structurally overloaded (`WebAssembly.Imports | LoadWasmOptions`)
 * and disambiguated at runtime by probing for `allowedOrigins`/`unsafelyAllowAnyOrigin`.
 * That is not a sound discriminator: an options bag carrying only `imports`
 * and/or `cacheKey` is valid TypeScript against the declared type, yet was
 * classified as a WASM import namespace — so `cacheKey` was dropped and the
 * documented keyed-singleton guarantee silently did not apply.
 *
 * A perfect structural discriminator cannot exist, because a WebAssembly module
 * namespace may legally be *named* `imports` or `cacheKey`. The fix is therefore
 * an unambiguous API, not a smarter guess.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWasmCache, loadWasmModule, loadWasmModuleWithOptions } from "../src/platform/wasm";

function fakeModule() {
  return {} as unknown as WebAssembly.Module;
}
function fakeInstance(exports: Record<string, unknown> = {}) {
  return { exports } as unknown as WebAssembly.Instance;
}

let instantiate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearWasmCache();
  instantiate = vi.fn(async () => fakeInstance({ n: instantiate.mock.calls.length }));
  (globalThis as Record<string, unknown>).WebAssembly = {
    compile: vi.fn(async () => fakeModule()),
    instantiate,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  clearWasmCache();
});

describe("loadWasmModuleWithOptions — options are never guessed", () => {
  it("honours an options bag containing only cacheKey", async () => {
    const bytes = new ArrayBuffer(8);
    const a = await loadWasmModuleWithOptions(bytes, { cacheKey: "same" });
    const b = await loadWasmModuleWithOptions(bytes, { cacheKey: "same" });

    expect(a).toBe(b);
    expect(instantiate).toHaveBeenCalledTimes(1);
  });

  it("honours an options bag containing only imports", async () => {
    const imports = { env: { log() {} } };
    await loadWasmModuleWithOptions(new ArrayBuffer(8), { imports });

    expect(instantiate).toHaveBeenCalledWith(expect.anything(), imports);
  });

  it("honours imports AND cacheKey together", async () => {
    const imports = { env: { log() {} } };
    const bytes = new ArrayBuffer(8);

    const a = await loadWasmModuleWithOptions(bytes, { imports, cacheKey: "x" });
    const b = await loadWasmModuleWithOptions(bytes, { imports, cacheKey: "x" });

    expect(a).toBe(b);
    expect(instantiate).toHaveBeenCalledTimes(1);
    // The REAL imports object must reach the engine, not a re-wrapped copy.
    expect(instantiate).toHaveBeenCalledWith(expect.anything(), imports);
  });

  it("does not confuse a module namespace legally named 'cacheKey'", async () => {
    // `cacheKey` here is a WASM module namespace, not an option. Passing it in
    // the `imports` slot of an options bag is unambiguous by construction.
    const imports = { cacheKey: { fn() {} }, imports: { other() {} } };
    await loadWasmModuleWithOptions(new ArrayBuffer(8), { imports });

    expect(instantiate).toHaveBeenCalledWith(expect.anything(), imports);
  });

  it("keeps distinct cache keys independent", async () => {
    const bytes = new ArrayBuffer(8);
    const a = await loadWasmModuleWithOptions(bytes, { cacheKey: "a" });
    const b = await loadWasmModuleWithOptions(bytes, { cacheKey: "b" });

    expect(a).not.toBe(b);
    expect(instantiate).toHaveBeenCalledTimes(2);
  });

  it("still enforces the origin policy for URL sources", async () => {
    await expect(loadWasmModuleWithOptions("https://cdn.example.com/x.wasm", {})).rejects.toThrow(/refused to fetch/);
  });
});

describe("loadWasmModule — legacy positional form is unchanged", () => {
  it("treats the second argument as WebAssembly.Imports", async () => {
    const imports = { env: { log() {} } };
    await loadWasmModule(new ArrayBuffer(8), imports);

    expect(instantiate).toHaveBeenCalledWith(expect.anything(), imports);
  });

  it("uses the third positional argument as the cache key", async () => {
    const bytes = new ArrayBuffer(8);
    const a = await loadWasmModule(bytes, undefined, "legacy");
    const b = await loadWasmModule(bytes, undefined, "legacy");

    expect(a).toBe(b);
    expect(instantiate).toHaveBeenCalledTimes(1);
  });

  it("passes a namespace named 'cacheKey' through as imports", async () => {
    const imports = { cacheKey: { fn() {} } };
    await loadWasmModule(new ArrayBuffer(8), imports);

    // In the positional form the second argument is ALWAYS imports — no
    // structural guessing, so a namespace named `cacheKey` is safe.
    expect(instantiate).toHaveBeenCalledWith(expect.anything(), imports);
  });
});
