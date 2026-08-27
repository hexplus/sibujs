/**
 * WebAssembly integration for SibuJS.
 * Provides hooks and utilities to load, cache, and use WASM modules
 * for performance-critical operations.
 */

import { signal } from "../core/signals/signal";
import { globalSingleton } from "../utils/globalSingleton";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WasmModuleState<T extends object = Record<string, unknown>> {
  /** The instantiated WASM module exports, null until loaded */
  instance: T | null;
  /** Loading state */
  loading: boolean;
  /** Error if loading failed */
  error: Error | null;
  /** Whether the module has been loaded successfully */
  ready: boolean;
}

/**
 * Configuration for the `wasm()` reactive wrapper.
 *
 * Deliberately the SAME option bag as the underlying `loadWasmModule()`
 * primitive rather than a hand-copied subset. The primitive REQUIRES an
 * explicit origin policy for URL sources (`allowedOrigins`, or an explicit
 * `unsafelyAllowAnyOrigin` opt-in), and the wrapper previously had no way to
 * express one — so `wasm("/math.wasm")` could only ever reject, and the public
 * convenience API was unusable for its documented primary use case. Extending
 * the primitive's type keeps the two from drifting again.
 */
export interface WasmConfig extends LoadWasmOptions {}

// ─── Module Cache ───────────────────────────────────────────────────────────

// Shared across duplicate module copies so a double-loaded bundle doesn't
// re-fetch/recompile the same WASM, and a keyed instance stays a true singleton.
const moduleCache = globalSingleton(
  Symbol.for("sibujs.wasm.moduleCache.v1"),
  () => new Map<string, WebAssembly.Module>(),
);
const instanceCache = globalSingleton(
  Symbol.for("sibujs.wasm.instanceCache.v1"),
  () => new Map<string, WebAssembly.Instance>(),
);
// In-flight loads, keyed the same way as `instanceCache`.
//
// A result-only cache cannot make a keyed load a singleton: two callers that
// both miss the cache before either finishes each run a full instantiation, and
// the "singleton instance" the API documents becomes two objects with two
// separate linear memories. Whoever set the cache last wins, and the other
// caller holds a detached instance whose mutations nobody else sees. Sharing
// the in-flight promise closes the window.
const inFlightCache = globalSingleton(
  Symbol.for("sibujs.wasm.inFlightCache.v1"),
  () => new Map<string, Promise<WebAssembly.Instance>>(),
);

/**
 * Cache generation — what makes {@link clearWasmCache} an invalidation BARRIER
 * rather than three `Map.clear()` calls.
 *
 * Clearing a map only erases what has already been written. A compile or
 * instantiation already in flight still holds the same global maps and writes
 * into them when it settles, so a caller that cleared the cache precisely to
 * force a fresh load — a hot reload, a test between cases, a version bump —
 * could have the invalidated module reinstated moments later BY THE WORK IT
 * INVALIDATED. Nothing in the maps distinguishes "written before the clear"
 * from "written after".
 *
 * A monotonic generation does. Every asynchronous producer captures the
 * generation it began in and may publish only while that is still current. The
 * operation still resolves normally to the caller that started it — cancelling
 * their load was never the intent — it simply may not repopulate a cache
 * generation it does not belong to.
 */
const cacheState = globalSingleton(Symbol.for("sibujs.wasm.cacheState.v1"), () => ({ generation: 0 }));

/** True while `generation` is still the live cache generation. */
function isCurrentGeneration(generation: number): boolean {
  return generation === cacheState.generation;
}

// ─── wasm Hook ───────────────────────────────────────────────────────────

/**
 * Hook to load and use a WebAssembly module reactively.
 * Returns reactive state that updates when the module loads.
 *
 * A URL source needs an explicit origin policy — WASM is compiled code with
 * imports into JS memory, so fetching it from an unvetted URL is a supply-chain
 * risk equivalent to importing a remote module (CWE-829). Pass `allowedOrigins`,
 * or `unsafelyAllowAnyOrigin: true` to opt out deliberately. An `ArrayBuffer` /
 * `Uint8Array` source needs neither: the bytes are already in hand.
 *
 * @example
 * ```ts
 * const math = wasm<{ add: (a: number, b: number) => number }>(
 *   'https://cdn.example.com/math.wasm',
 *   { allowedOrigins: ['https://cdn.example.com'] },
 * );
 * // In reactive context:
 * if (math.ready()) {
 *   const result = math.instance()!.add(1, 2);
 * }
 * ```
 *
 * @example Same-origin asset — still an explicit decision.
 * ```ts
 * const math = wasm('/math.wasm', { allowedOrigins: [location.origin] });
 * ```
 */
export function wasm<T extends object = Record<string, unknown>>(
  source: string | ArrayBuffer | Uint8Array,
  config: WasmConfig = {},
): {
  instance: () => T | null;
  loading: () => boolean;
  error: () => Error | null;
  ready: () => boolean;
  reload: () => Promise<void>;
} {
  const [instance, setInstance] = signal<T | null>(null);
  const [loading, setLoading] = signal(true);
  const [error, setError] = signal<Error | null>(null);

  const cacheKey = config.cacheKey || (typeof source === "string" ? source : undefined);

  async function load() {
    setLoading(true);
    setError(null);
    setInstance(null);

    try {
      // Forward the WHOLE config — including `allowedOrigins` /
      // `unsafelyAllowAnyOrigin` — through the options-only entry point. The
      // previous call passed `config.imports` positionally, so the security
      // options the wrapper accepted were silently dropped and every URL source
      // was refused by the primitive.
      const wasmInstance = await loadWasmModuleWithOptions(source, { ...config, cacheKey });
      setInstance(wasmInstance.exports as unknown as T);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }

  // Start loading immediately
  load();

  return {
    instance,
    loading,
    error,
    ready: () => instance() !== null,
    reload: load,
  };
}

// ─── loadWasmModule ─────────────────────────────────────────────────────────

/**
 * Load and instantiate a WebAssembly module.
 * Supports loading from URL, ArrayBuffer, or Uint8Array.
 *
 * Caching: keyed by `cacheKey` (or, for a URL source, the URL itself). A keyed
 * load is memoized as a **singleton instance** — every caller with the same key
 * receives the *same* `WebAssembly.Instance`, which shares one linear memory and
 * mutable globals. This is intentional (load-once / reuse), but it means callers
 * that need isolated state must use distinct cache keys, or pass a non-URL source
 * with no `cacheKey` (which instantiates fresh every call). Compiled modules are
 * immutable and always safe to share.
 */
export interface LoadWasmOptions {
  imports?: WebAssembly.Imports;
  cacheKey?: string;
  allowedOrigins?: string[];
  /** Required when source is a URL and allowedOrigins is empty. WASM is
   *  compiled code with imports into JS memory — fetching from any URL is
   *  a supply-chain risk equivalent to remote module import (CWE-829). */
  unsafelyAllowAnyOrigin?: boolean;
}

/**
 * Load and instantiate a WebAssembly module — **positional/legacy form**.
 *
 * The second parameter is always `WebAssembly.Imports` and the third is always
 * the cache key. There is no structural guessing, so a module namespace legally
 * named `imports` or `cacheKey` is passed through unharmed.
 *
 * It previously accepted `WebAssembly.Imports | LoadWasmOptions` and decided
 * between them at runtime by probing for `allowedOrigins` /
 * `unsafelyAllowAnyOrigin`. That discriminator was unsound in both directions:
 * an options bag carrying only `imports`/`cacheKey` was read as an import
 * namespace (so `cacheKey` was dropped and the documented keyed-singleton
 * guarantee silently did not hold), while a genuine namespace *named*
 * `allowedOrigins` would have been read as options. No structural test can
 * separate the two, because both are plain objects with caller-chosen keys — so
 * the union was removed rather than re-guessed.
 *
 * For anything beyond imports and a cache key — notably the origin policy a URL
 * source requires — use {@link loadWasmModuleWithOptions}.
 *
 * @see loadWasmModuleWithOptions
 */
export async function loadWasmModule(
  source: string | ArrayBuffer | Uint8Array,
  imports?: WebAssembly.Imports,
  cacheKey?: string,
): Promise<WebAssembly.Instance> {
  return loadWasmModuleWithOptions(source, { imports, cacheKey });
}

/**
 * Load and instantiate a WebAssembly module — **options form**.
 *
 * Unambiguous by construction: options live in their own parameter, so a WASM
 * module namespace named `imports`, `cacheKey`, or `allowedOrigins` is just a
 * namespace and nothing has to be inferred from object shape.
 *
 * This is the form to use for a URL source, since the origin policy
 * (`allowedOrigins`, or an explicit `unsafelyAllowAnyOrigin`) can only be
 * expressed here.
 *
 * @example
 * ```ts
 * const instance = await loadWasmModuleWithOptions("https://cdn.example.com/math.wasm", {
 *   allowedOrigins: ["https://cdn.example.com"],
 *   imports: { env: { log: console.log } },
 *   cacheKey: "math",
 * });
 * ```
 */
export async function loadWasmModuleWithOptions(
  source: string | ArrayBuffer | Uint8Array,
  opts: LoadWasmOptions = {},
): Promise<WebAssembly.Instance> {
  const key = opts.cacheKey || (typeof source === "string" ? source : undefined);

  // Origin policy runs BEFORE any cache lookup: a refused origin must be
  // refused even when some earlier, permitted call already populated the key.
  if (typeof source === "string") {
    const allowed = opts.allowedOrigins ?? [];
    if (allowed.length > 0) {
      let parsed: URL;
      try {
        parsed = new URL(source, typeof location !== "undefined" ? location.href : undefined);
      } catch {
        throw new Error(`loadWasmModule: invalid URL "${source}"`);
      }
      if (!allowed.includes(parsed.origin)) {
        throw new Error(`loadWasmModule: origin "${parsed.origin}" is not in the allowlist`);
      }
    } else if (!opts.unsafelyAllowAnyOrigin) {
      throw new Error(
        `loadWasmModule: refused to fetch "${source}" with no allowedOrigins. ` +
          "Pass { allowedOrigins: [...] } to restrict the origin, or " +
          "{ unsafelyAllowAnyOrigin: true } to opt in (CWE-829).",
      );
    }
  }

  // The generation this load belongs to. Captured before any await so a clear
  // that happens while it runs is observable at publish time.
  const generation = cacheState.generation;

  // Unkeyed loads are documented to instantiate fresh every call — no sharing.
  if (!key) return instantiateWasm(source, opts.imports, undefined, generation);

  const cachedInstance = instanceCache.get(key);
  if (cachedInstance) return cachedInstance;

  const inFlight = inFlightCache.get(key);
  if (inFlight) return inFlight;

  const pending = instantiateWasm(source, opts.imports, key, generation).then((instance) => {
    // Publish only into the generation this load started in. The caller still
    // receives the instance; it just does not become the cached singleton for a
    // generation that explicitly discarded it.
    if (isCurrentGeneration(generation)) instanceCache.set(key, instance);
    return instance;
  });
  inFlightCache.set(key, pending);

  // Evict on settle so a FAILED load does not poison the key forever — the
  // next caller retries from scratch. Guarded by identity so a retry that has
  // already registered its own promise is not evicted by the loser's cleanup.
  // The `.catch` consumes the rejection on THIS derived chain only; `pending`
  // itself still rejects for every real awaiter.
  void pending
    .catch(() => {})
    .then(() => {
      if (inFlightCache.get(key) === pending) inFlightCache.delete(key);
    });

  return pending;
}

/**
 * Fetch/compile/instantiate.
 *
 * `generation` is the cache generation the caller began in; every module-cache
 * write is conditional on it still being live. Both compile paths publish, so
 * both are guarded — fixing only the instance cache would leave the compiled
 * module behind, and the next load would silently reuse pre-clear bytes.
 */
async function instantiateWasm(
  source: string | ArrayBuffer | Uint8Array,
  wasmImports: WebAssembly.Imports | undefined,
  key: string | undefined,
  generation: number,
): Promise<WebAssembly.Instance> {
  const cachedModule = key ? moduleCache.get(key) : undefined;
  if (cachedModule) {
    return WebAssembly.instantiate(cachedModule, wasmImports || {});
  }

  let bytes: ArrayBuffer;
  if (typeof source === "string") {
    // URL - use streaming compilation if available
    if (typeof WebAssembly.instantiateStreaming === "function") {
      const response = fetch(source);
      const result = await WebAssembly.instantiateStreaming(response, wasmImports || {});
      if (key && isCurrentGeneration(generation)) moduleCache.set(key, result.module);
      return result.instance;
    }
    const response = await fetch(source);
    bytes = await response.arrayBuffer();
  } else if (source instanceof Uint8Array) {
    bytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
  } else {
    bytes = source;
  }

  const module = await WebAssembly.compile(bytes);
  if (key && isCurrentGeneration(generation)) moduleCache.set(key, module);
  return WebAssembly.instantiate(module, wasmImports || {});
}

// ─── preloadWasm ────────────────────────────────────────────────────────────

/**
 * Preload and compile a WASM module without instantiating it.
 * The compiled module is cached for instant instantiation later.
 */
export async function preloadWasm(
  url: string,
  options: { allowedOrigins?: string[]; unsafelyAllowAnyOrigin?: boolean } = {},
): Promise<void> {
  if (moduleCache.has(url)) return;
  // Same barrier as the loader: a preload compiling across a clear must not
  // reinstate the module the clear discarded.
  const generation = cacheState.generation;
  const allowed = options.allowedOrigins ?? [];
  if (allowed.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(url, typeof location !== "undefined" ? location.href : undefined);
    } catch {
      throw new Error(`preloadWasm: invalid URL "${url}"`);
    }
    if (!allowed.includes(parsed.origin)) {
      throw new Error(`preloadWasm: origin "${parsed.origin}" is not in the allowlist`);
    }
  } else if (!options.unsafelyAllowAnyOrigin) {
    throw new Error(
      `preloadWasm: refused to fetch "${url}" with no allowedOrigins. ` +
        "Pass { allowedOrigins: [...] } or { unsafelyAllowAnyOrigin: true } (CWE-829).",
    );
  }

  let module: WebAssembly.Module;
  if (typeof WebAssembly.compileStreaming === "function") {
    module = await WebAssembly.compileStreaming(fetch(url));
  } else {
    const response = await fetch(url);
    const bytes = await response.arrayBuffer();
    module = await WebAssembly.compile(bytes);
  }
  if (isCurrentGeneration(generation)) moduleCache.set(url, module);
}

// ─── createWasmBridge ───────────────────────────────────────────────────────

/**
 * Create a type-safe bridge to a WASM module with automatic memory management.
 * Provides helpers for passing strings and arrays between JS and WASM.
 */
export function createWasmBridge<T extends object>(
  instance: WebAssembly.Instance,
): {
  exports: T;
  memory: WebAssembly.Memory;
  /** Allocate bytes in WASM memory (requires WASM to export malloc) */
  alloc: (size: number) => number;
  /** Free allocated memory (requires WASM to export free) */
  free: (ptr: number) => void;
  /** Write a string to WASM memory, returns pointer */
  writeString: (str: string) => { ptr: number; len: number };
  /** Read a string from WASM memory */
  readString: (ptr: number, len: number) => string;
  /** Write a typed array to WASM memory, returns pointer */
  writeArray: (arr: ArrayLike<number>) => { ptr: number; len: number };
  /** Read a Float64Array from WASM memory */
  readF64Array: (ptr: number, len: number) => Float64Array;
} {
  const exports = instance.exports as unknown as T & {
    memory?: WebAssembly.Memory;
    malloc?: (size: number) => number;
    free?: (ptr: number) => void;
  };

  const memory = exports.memory || (instance.exports.memory as WebAssembly.Memory);

  return {
    exports: instance.exports as unknown as T,
    memory,
    alloc(size: number): number {
      if (!exports.malloc) throw new Error("WASM module does not export malloc");
      return exports.malloc(size);
    },
    free(ptr: number): void {
      if (!exports.free) throw new Error("WASM module does not export free");
      exports.free(ptr);
    },
    writeString(str: string) {
      const encoder = new TextEncoder();
      const bytes = encoder.encode(str);
      if (!exports.malloc) throw new Error("WASM module does not export malloc");
      const ptr = exports.malloc(bytes.length);
      new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
      return { ptr, len: bytes.length };
    },
    readString(ptr: number, len: number) {
      const decoder = new TextDecoder();
      return decoder.decode(new Uint8Array(memory.buffer, ptr, len));
    },
    writeArray(arr: ArrayLike<number>) {
      if (!exports.malloc) throw new Error("WASM module does not export malloc");
      const ptr = exports.malloc(arr.length * 8);
      new Float64Array(memory.buffer, ptr, arr.length).set(Array.from(arr));
      return { ptr, len: arr.length };
    },
    readF64Array(ptr: number, len: number) {
      return new Float64Array(memory.buffer, ptr, len);
    },
  };
}

// ─── Cache Management ───────────────────────────────────────────────────────

/**
 * Invalidate the module, instance, and in-flight WASM cache generations.
 *
 * CONTRACT: work already started may still resolve to the callers that started
 * it, but must never repopulate the caches after the clear. A load in flight
 * across this call therefore still returns its instance to whoever awaited it,
 * while the cache stays empty and the next load for that key compiles and
 * instantiates afresh.
 *
 * This is an invalidation BARRIER, not a `Map.clear()`: emptying the maps alone
 * would let the invalidated work write its results straight back in.
 */
export function clearWasmCache(): void {
  // Advance the generation FIRST. Any producer already in flight captured the
  // previous one, so from this statement onward none of them can publish —
  // including one that settles between these lines.
  cacheState.generation++;
  moduleCache.clear();
  instanceCache.clear();
  // In-flight entries are dropped too, so a load started after the clear does
  // not join a pre-clear operation and inherit its invalidated result.
  inFlightCache.clear();
}

/**
 * Check if a WASM module is cached.
 */
export function isWasmCached(key: string): boolean {
  return moduleCache.has(key);
}
