import type { ReactiveSignal } from "../../reactivity/signal";
import { recordDependency, retrack, track, trackingSuspended } from "../../reactivity/track";
import { devAssert } from "../dev";
import type { Accessor } from "./signal";

/**
 * derived creates a derived reactive signal whose value updates when dependencies change.
 *
 * Uses lazy pull-based evaluation with dirty flagging:
 * - When a dependency changes, the computed is marked dirty (no re-evaluation).
 * - Dirtiness propagates downstream via propagateDirty.
 * - The getter only re-evaluates when actually read (pull-based).
 * - On re-evaluation, dependencies are re-tracked via track() so that
 *   derived-of-derived chains propagate correctly.
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
  cs._g = getter;

  const markDirty = (): void => {
    if (cs._d) return;
    cs._d = true;
  };
  (markDirty as any)._c = 1;
  (markDirty as any)._sig = cs;

  // Initial evaluation — sets up dependencies
  track(() => {
    let threw = true;
    try {
      cs._v = getter();
      cs._d = false;
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

    if (trackingSuspended) {
      if (cs._d) {
        evaluating = true;
        let threw = true;
        try {
          // Use retrack (epoch-based sweep) so steady-state chains skip
          // Set.delete+add cycles on every pull — only deps that actually
          // changed do Set mutations.
          retrack(() => {
            cs._v = getter();
            cs._d = false;
            threw = false;
          }, markDirty);
        } finally {
          evaluating = false;
          if (threw) cs._d = true;
        }
      }
      return cs._v;
    }

    // Record that the caller depends on this derived
    recordDependency(cs as ReactiveSignal);

    if (cs._d) {
      const oldValue = cs._v;

      evaluating = true;
      let threw = true;
      try {
        // retrack (no cleanup, no stack array push) so new conditional
        // deps acquired by the getter still subscribe markDirty. Steady-
        // state chains skip the Set.delete+add cycle that track() incurs.
        retrack(() => {
          const next = getter();
          // If caller provided a custom equality fn and the value didn't
          // change under it, preserve the prior reference — upstream
          // notifications to subscribers checking `oldValue !== cs._v`
          // (e.g. the devtools hook below) will correctly skip.
          cs._v = equals && cs._v !== undefined ? (equals(cs._v, next) ? cs._v : next) : next;
          cs._d = false;
          threw = false;
        }, markDirty);
      } finally {
        evaluating = false;
        if (threw) cs._d = true;
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
