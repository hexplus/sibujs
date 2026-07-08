// ---------------------------------------------------------------------------
// @sibujs/core/internal — shared plumbing consumed by the `sibujs` std package.
// NOT part of the public @sibujs/core API: no stability guarantees across
// versions. External consumers must not import from here.
// ---------------------------------------------------------------------------
export * from "./src/core/dev";
export * from "./src/reactivity/track";
export * from "./src/reactivity/bindAttribute";
export type { ReactiveSignal } from "./src/reactivity/signal";
export * from "./src/utils/sanitize";
export * from "./src/utils/globalSingleton";
