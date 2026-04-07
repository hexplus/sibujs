import type { ReactiveSignal } from "../../reactivity/signal";
import { recordDependency, track, trackingSuspended } from "../../reactivity/track";
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
export function derived<T>(getter: () => T, options?: { name?: string }): Accessor<T> {
  devAssert(typeof getter === "function", "derived: argument must be a getter function.");
  const debugName = options?.name;
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
    cs._d = false;
    cs._v = getter();
  }, markDirty);

  // DevTools: emit computed:create
  const hook = (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__;

  function computedGetter(): T {
    if (trackingSuspended) {
      // Called during another derived's re-evaluation (propagateDirty eager path).
      // Re-evaluate if dirty but don't re-track (we're inside suspended context).
      if (cs._d) {
        cs._d = false;
        cs._v = getter();
      }
      return cs._v;
    }

    // Record that the caller depends on this derived
    recordDependency(cs as ReactiveSignal);

    if (cs._d) {
      const oldValue = cs._v;

      // Re-evaluate AND re-track dependencies.
      // This is the key fix: track() cleans old deps and registers new ones,
      // so derived-of-derived chains (e.g. F6=SUM(F2:F4) where F2 is also
      // a formula) always have up-to-date dependency links.
      track(() => {
        cs._d = false;
        cs._v = getter();
      }, markDirty);

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
