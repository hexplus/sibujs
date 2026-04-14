/**
 * WebAssembly integration for SibuJS.
 * Provides hooks and utilities to load, cache, and use WASM modules
 * for performance-critical operations.
 */

import { signal } from "../core/signals/signal";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WasmModuleState<T extends Record<string, unknown> = Record<string, unknown>> {
  /** The instantiated WASM module exports, null until loaded */
  instance: T | null;
  /** Loading state */
  loading: boolean;
  /** Error if loading failed */
  error: Error | null;
  /** Whether the module has been loaded successfully */
  ready: boolean;
}

export interface WasmConfig {
  /** Import object passed to WebAssembly.instantiate */
  imports?: WebAssembly.Imports;
  /** Cache key for module caching (defaults to URL) */
  cacheKey?: string;
}

// ─── Module Cache ───────────────────────────────────────────────────────────

const moduleCache = new Map<string, WebAssembly.Module>();
const instanceCache = new Map<string, WebAssembly.Instance>();

// ─── wasm Hook ───────────────────────────────────────────────────────────

/**
 * Hook to load and use a WebAssembly module reactively.
 * Returns reactive state that updates when the module loads.
 *
 * @example
 * ```ts
 * const wasm = wasm<{ add: (a: number, b: number) => number }>('/math.wasm');
 * // In reactive context:
 * if (wasm.ready()) {
 *   const result = wasm.instance()!.add(1, 2);
 * }
 * ```
 */
export function wasm<T extends Record<string, unknown> = Record<string, unknown>>(
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
      const wasmInstance = await loadWasmModule(source, config.imports, cacheKey);
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
 * Caches compiled modules for reuse.
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

export async function loadWasmModule(
  source: string | ArrayBuffer | Uint8Array,
  imports?: WebAssembly.Imports | LoadWasmOptions,
  cacheKey?: string,
): Promise<WebAssembly.Instance> {
  // Back-compat: `imports` may be either WebAssembly.Imports (a record of
  // module-name -> imports map) or a LoadWasmOptions bag. Disambiguate via
  // the unique option keys ONLY — never `imports`/`cacheKey`, which a user
  // could legally name a WASM module namespace.
  const isOptionsBag = !!(imports && ("allowedOrigins" in imports || "unsafelyAllowAnyOrigin" in imports));
  const opts: LoadWasmOptions = isOptionsBag
    ? (imports as LoadWasmOptions)
    : { imports: imports as WebAssembly.Imports | undefined, cacheKey };
  const wasmImports = opts.imports;
  const key = opts.cacheKey || (typeof source === "string" ? source : undefined);

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

  // Check instance cache
  if (key) {
    const cachedInstance = instanceCache.get(key);
    if (cachedInstance) {
      return cachedInstance;
    }
  }

  let module: WebAssembly.Module;

  // Check module cache
  const cachedModule = key ? moduleCache.get(key) : undefined;
  if (cachedModule) {
    module = cachedModule;
  } else {
    // Fetch and compile
    let bytes: ArrayBuffer;
    if (typeof source === "string") {
      // URL - use streaming compilation if available
      if (typeof WebAssembly.instantiateStreaming === "function") {
        const response = fetch(source);
        const result = await WebAssembly.instantiateStreaming(response, wasmImports || {});
        if (key) {
          moduleCache.set(key, result.module);
          instanceCache.set(key, result.instance);
        }
        return result.instance;
      }
      const response = await fetch(source);
      bytes = await response.arrayBuffer();
    } else if (source instanceof Uint8Array) {
      bytes = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
    } else {
      bytes = source;
    }

    module = await WebAssembly.compile(bytes);
    if (key) moduleCache.set(key, module);
  }

  // Instantiate
  const instance = await WebAssembly.instantiate(module, wasmImports || {});
  if (key) instanceCache.set(key, instance);
  return instance;
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
  moduleCache.set(url, module);
}

// ─── createWasmBridge ───────────────────────────────────────────────────────

/**
 * Create a type-safe bridge to a WASM module with automatic memory management.
 * Provides helpers for passing strings and arrays between JS and WASM.
 */
export function createWasmBridge<T extends Record<string, unknown>>(
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
 * Clear all cached WASM modules and instances.
 */
export function clearWasmCache(): void {
  moduleCache.clear();
  instanceCache.clear();
}

/**
 * Check if a WASM module is cached.
 */
export function isWasmCached(key: string): boolean {
  return moduleCache.has(key);
}
