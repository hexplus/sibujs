import type { ReactiveSignal } from "../../reactivity/signal";
import { isTrackingSuspended, recordDependency, retrack, track } from "../../reactivity/track";
import { devAssert } from "../dev";
import type { Accessor } from "./signal";

/**
 * derived creates a derived reactive signal whose value updates when dependencies change.
 *
 * Uses lazy pull-based evaluation with a single dirty flag:
 * - When a dependency changes, the computed is marked dirty (no re-evaluation).
 * - Dirtiness propagates downstream via propagateDirty.
 * - The getter only re-evaluates when actually read (pull-based).
 * - On re-evaluation, dependencies are re-tracked via retrack() so that
 *   derived-of-derived chains propagate correctly without paying the full
 *   Set-delete + re-add cost of track()'s cleanup phase.
 *
 * NOTE: a previous revision experimented with three-color (CLEAN/CHECK/DIRTY)
 * state for read-side value-change short-circuiting. It regressed every
 * benchmark except Memory (Deep Chain +122%, Component Tree +20%) because
 * the workloads always produce a new downstream value and CHECK had no
 * work to skip — only overhead to add. Keeping the simpler boolean flag
 * here; revisit CHECK propagation when we have benchmarks that exercise
 * stabilisation on diamond / conditional-branch patterns.
 */
export function derived<T>(
  getter: () => T,
  options?: {
    name?: string;
    /**
     * Custom equality for the derived's CACHED VALUE. When a recompute produces
     * a value that `equals` the previous, the derived keeps returning the prior
     * reference (its identity is preserved) — useful for object/array results
     * consumed by identity-sensitive readers. Defaults to `Object.is`.
     *
     * NOTE: this does NOT suppress downstream notification. Propagation is
     * push-eager — a write marks all transitive subscribers dirty before this
     * derived is pulled — so an effect that reads this derived still re-runs
     * when an upstream dependency changes, even if `equals` reports the
     * recomputed value as unchanged. `equals` controls value caching, not
     * effect short-circuiting.
     */
    equals?: (a: T, b: T) => boolean;
  },
): Accessor<T> {
  devAssert(typeof getter === "function", "derived: argument must be a getter function.");
  const debugName = options?.name;
  const equals = options?.equals;
  const cs: any = {};
  cs._d = false;
  // Becomes true once the getter has produced at least one value. Used to gate
  // the custom-`equals` short-circuit: comparing against `_v !== undefined`
  // wrongly disabled `equals` whenever the previous value was a legitimate
  // `undefined`, causing spurious version bumps / downstream notifications.
  cs._init = false;
  cs._g = getter;
  // __v: monotonic version counter, bumped only when re-evaluation produces
  // a value different from the previous (Object.is comparison). Kept on the
  // computed so future read-side short-circuit work can compare against it.
  cs.__v = 0;

  const markDirty = (): void => {
    if (cs._d) return;
    cs._d = true;
  };
  (markDirty as any)._c = 1;
  (markDirty as any)._sig = cs;

  // Recompute body, allocated ONCE per derived (not per recompute). Hoisting it
  // out of the getter avoids a closure allocation on every propagation — the
  // dominant overhead in deep-chain / high-fanout recompute workloads. On entry
  // to a recompute `cs._d` is always true; this sets it false only after the
  // getter succeeds, so a throwing getter simply leaves the computed dirty (it
  // will retry) without any extra `threw` bookkeeping.
  //
  // NOTE on stack depth: dirty MARKING is iterative (see propagateDirty in
  // track.ts), but VALUE recomputation is pull-based and therefore recursive in
  // chain depth — reading a dirty computed whose upstream is also dirty calls
  // `getter()` → upstream `computedGetter()` → `retrack(recompute)` → … one JS
  // frame per level. Practically this only matters for derived-of-derived
  // chains thousands of levels deep that are fully invalidated and then read;
  // such depths are unusual (the engine's own stack limit is the bound).
  const recompute = (): void => {
    const next = getter();
    cs._v = equals && cs._init ? (equals(cs._v, next) ? cs._v : next) : next;
    cs._d = false;
    cs._init = true;
  };

  // Initial evaluation — sets up dependencies
  track(() => {
    let threw = true;
    try {
      cs._v = getter();
      cs._d = false;
      cs._init = true;
      threw = false;
    } finally {
      if (threw) cs._d = true;
    }
  }, markDirty);

  // DevTools: emit computed:create
  const hook = (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__;

  let evaluating = false;

  function computedGetter(): T {
    if (evaluating) {
      throw new Error(
        `[SibuJS] Circular dependency detected in derived${debugName ? ` "${debugName}"` : ""}. ` +
          "A derived signal cannot read itself (directly or through a chain).",
      );
    }

    if (isTrackingSuspended()) {
      if (cs._d) {
        const prev = cs._v;
        evaluating = true;
        try {
          retrack(recompute, markDirty);
          if (!Object.is(prev, cs._v)) cs.__v++;
        } finally {
          evaluating = false;
        }
      }
      return cs._v;
    }

    // Record that the caller depends on this derived
    recordDependency(cs as ReactiveSignal);

    if (cs._d) {
      const oldValue = cs._v;

      evaluating = true;
      try {
        retrack(recompute, markDirty);
        if (!Object.is(oldValue, cs._v)) cs.__v++;
      } finally {
        evaluating = false;
      }

      // DevTools: emit computed recomputation
      if (hook && oldValue !== cs._v) {
        hook.emit("computed:update", { signal: cs, oldValue, newValue: cs._v });
      }
    }
    return cs._v;
  }

  // Tag getter for devtools introspection
  if (debugName) {
    (computedGetter as unknown as Record<string, unknown>).__name = debugName;
    cs.__name = debugName;
  }
  (computedGetter as unknown as Record<string, unknown>).__signal = cs;

  if (hook) hook.emit("computed:create", { signal: cs, name: debugName, getter: computedGetter });

  return computedGetter as Accessor<T>;
}
