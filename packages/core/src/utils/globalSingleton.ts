/**
 * First-copy-wins singleton holder.
 *
 * Returns the value stored on `globalThis` under `key`, creating it (once) from
 * `create` if absent. This makes a piece of coordination state survive a
 * bundler loading this module more than once on a page (Vite `optimizeDeps` /
 * esbuild dependency pre-bundling can materialize the same chunk twice). Every
 * duplicate copy resolves the SAME object, so they coordinate instead of
 * silently splitting into independent worlds.
 *
 * The helper itself is pure (only reads/writes `globalThis[key]`), so it is
 * safe under duplication too — whichever copy runs first wins the `??=`.
 *
 * Keys MUST be created with `Symbol.for(...)` so duplicate module copies share
 * the same symbol. Use a versioned suffix (`"sibujs.<name>.v1"`) and only bump
 * the version on an incompatible change to the held value's shape.
 *
 * @example
 * const cache = globalSingleton(Symbol.for("sibujs.query.v1"), () => new Map());
 */
export function globalSingleton<T>(key: symbol, create: () => T): T {
  const g = globalThis as typeof globalThis & Record<symbol, unknown>;
  return (g[key] ??= create()) as T;
}
