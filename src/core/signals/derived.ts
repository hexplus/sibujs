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
 * STABILIZATION — why a dirty flag is enough:
 *
 * A dirty computed does NOT imply a changed value. Downstream effects are
 * enqueued by `propagateDirty` at write time, before this computed has had a
 * chance to recompute and compare. Rather than adding a three-color
 * (CLEAN/CHECK/DIRTY) propagation pass — which an earlier revision measured as
 * a regression on every benchmark, because the extra state has nothing to skip
 * when values genuinely change — the engine settles the question lazily at
 * DRAIN time: `cs._validate` recomputes a dirty computed and `cs.__v` is bumped
 * ONLY when the new value differs under this computed's comparator. The
 * scheduler compares that version against what each subscriber last observed
 * and suppresses the run when nothing changed (see `depsChanged` in
 * ../../reactivity/track-core.ts).
 *
 * That keeps the cheap boolean dirty flag AND makes `equals` actually stop
 * propagation, with recomputation still fully lazy: `_validate` only ever runs
 * when an effect is genuinely about to observe the value.
 */
export function derived<T>(
  getter: () => T,
  options?: {
    name?: string;
    /** Custom equality — when the recomputed value equals the previous,
     *  downstream subscribers are not notified. Defaults to `Object.is`. */
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

  // Settle a dirty computed: recompute, then bump `__v` ONLY if the result
  // differs from the previous value. `recompute` already applies the custom
  // comparator by keeping the OLD reference when `equals` says they match, so
  // the `Object.is` here covers both the default and custom-`equals` cases.
  //
  // Published on the state object because the scheduler needs to settle a
  // computed's value before deciding whether dependents must run — it holds a
  // reference to `cs`, not to this getter. See `depsChanged` in track-core.
  const validate = (): void => {
    if (!cs._d) return;
    const oldValue = cs._v;
    evaluating = true;
    try {
      retrack(recompute, markDirty);
      if (!Object.is(oldValue, cs._v)) cs.__v++;
    } finally {
      evaluating = false;
    }
    if (hook && !Object.is(oldValue, cs._v)) {
      hook.emit("computed:update", { signal: cs, oldValue, newValue: cs._v });
    }
  };
  cs._validate = validate;

  function computedGetter(): T {
    if (evaluating) {
      throw new Error(
        `[SibuJS] Circular dependency detected in derived${debugName ? ` "${debugName}"` : ""}. ` +
          "A derived signal cannot read itself (directly or through a chain).",
      );
    }

    // The dirty test is inlined at both call sites rather than living inside
    // `validate()`. Reading a CLEAN computed is the hottest operation in the
    // engine — a diamond or wide fan-in reads its computeds many times per
    // update — and folding the check into the callee turned every one of those
    // reads into a function call that immediately returned. Inline, the clean
    // path is a single boolean load again.
    if (isTrackingSuspended()) {
      if (cs._d) validate();
      return cs._v;
    }

    // Settle BEFORE recording the edge. `recordDependency` stamps the edge with
    // `cs.__v`, and that stamp must describe the value we are about to return —
    // stamping a pre-recompute version would make the reader look permanently
    // stale and re-run it on every unrelated upstream write.
    if (cs._d) validate();
    recordDependency(cs as ReactiveSignal);
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
