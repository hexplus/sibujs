import type { ReactiveSignal } from "../../reactivity/signal";
import { cleanup, isTrackingSuspended, recordDependency, retrack, track } from "../../reactivity/track";
import { devAssert } from "../dev";
import { emitDevtools } from "../devtoolsHook";
import {
  beginDisposerCapture,
  currentDisposerCapture,
  endDisposerCapture,
  registerRollbackCleanup,
} from "../rendering/dispose";
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
 *
 * DISPOSAL — a derived subscribes to its sources when it is created, and those
 * edges live as long as the sources do. A derived created per mount (one per
 * virtualized row, say) must be released when its owner goes away:
 * `flag.dispose()`, or `onCleanup(flag.dispose, rowNode)` to tie it to a node.
 * A disposed accessor is inert: it keeps returning the last value it settled,
 * never recomputes, never re-subscribes, and never wakes downstream readers.
 * Disposal is idempotent. A derived created while a component renders belongs
 * to that render and is disposed if the render throws; create a shared or
 * lazily cached one inside `detached()`.
 *
 * ERRORS — a recomputation that throws is thrown to the next reader, in that
 * reader's context: a binding reports it with its node (so the nearest
 * `ErrorBoundary` can claim it), an effect reports it, a direct caller can catch
 * it, and a derived reading another derived passes it on. A live derived stays
 * dirty and recomputes on the following read; a derived that disposed itself
 * during the failing run returns its frozen value afterwards.
 *
 * @returns An accessor for the computed value. It recomputes lazily on read
 * after any dependency changes, and carries `dispose()` to release its source
 * subscriptions.
 */
export function derived<T>(
  getter: () => T,
  options?: {
    name?: string;
    /** Custom equality — when the recomputed value equals the previous,
     *  downstream subscribers are not notified. Defaults to `Object.is`. */
    equals?: (a: T, b: T) => boolean;
  },
): DerivedAccessor<T> {
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
  // A live recompute threw; see `_f` in track-core's SignalWithList.
  cs._f = false;
  cs._g = getter;
  // __v: monotonic version counter, bumped only when re-evaluation produces
  // a value different from the previous (Object.is comparison). Kept on the
  // computed so future read-side short-circuit work can compare against it.
  cs.__v = 0;

  // Declared before `markDirty` and the initial track so every closure below
  // sees the binding (no temporal-dead-zone reads).
  let evaluating = false;
  let disposed = false;
  // The exception from the last failed recomputation, kept until one reader
  // takes it. See `validate` for why it cannot be thrown on the spot.
  let pendingError: { error: unknown } | undefined;

  const markDirty = (): void => {
    // Inert once disposed: nothing may make a released computed dirty again.
    if (cs._d || disposed) return;
    cs._d = true;
  };
  (markDirty as any)._c = 1;
  (markDirty as any)._sig = cs;
  // The render transaction this computed was created in (null outside one).
  // Stamped here, not on the first recompute: that runs wherever the first
  // reader happens to be, and would hand ownership to the reader's render.
  (markDirty as any)._cap = currentDisposerCapture();

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

  // Initial evaluation — sets up dependencies. A throwing first run never
  // returns the accessor, so nothing could ever call `dispose()`: release the
  // edges it recorded before the throw, or its sources keep `markDirty` — and
  // through it this whole computed — alive for as long as they live.
  try {
    track(() => {
      cs._v = getter();
      cs._d = false;
      cs._init = true;
    }, markDirty);
  } catch (err) {
    disposed = true;
    cleanup(markDirty);
    throw err;
  }

  // DevTools: emit computed:create
  const hook = (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__;

  // Settle a dirty computed: recompute, then bump `__v` ONLY if the result
  // differs from the previous value. `recompute` already applies the custom
  // comparator by keeping the OLD reference when `equals` says they match, so
  // the `Object.is` here covers both the default and custom-`equals` cases.
  //
  // Published on the state object because the scheduler needs to settle a
  // computed's value before deciding whether dependents must run — it holds a
  // reference to `cs`, not to this getter. See `depsChanged` in track-core.
  const validate = (): void => {
    // A disposed computed must not recompute: `retrack` would re-link the very
    // source edges `dispose()` released. A failure still waiting for its reader
    // must not be overwritten by a retry that nobody has asked for yet.
    if (!cs._d || disposed || pendingError !== undefined) return;
    const oldValue = cs._v;
    evaluating = true;
    // A recompute runs in the READER's context, so anything the getter creates
    // (a nested derived, an effect) would otherwise belong to the reader's
    // render and be disposed if that render failed — while this computed keeps
    // it in its cached value. Register into this computed's own transaction
    // instead, exactly as the scheduler does for a subscriber's re-run.
    const pushed = beginDisposerCapture((markDirty as any)._cap ?? null);
    try {
      retrack(recompute, markDirty);
      if (!Object.is(oldValue, cs._v)) cs.__v++;
    } catch (err) {
      // The failure is kept for the NEXT reader, which takes it exactly once,
      // instead of being thrown from here.
      //
      // Thrown from here, it is lost whenever the caller is the scheduler's
      // validation step, which swallows it expecting the subscriber's own read
      // to throw again. That expectation fails whenever the retry cannot
      // reproduce the error: a computed that disposed itself returns its frozen
      // value, and a computed downstream of one recomputes against that frozen
      // value and succeeds. Reporting it from here instead would bypass the
      // reader's error handling — a binding reports with its node, which is
      // what lets the nearest ErrorBoundary claim it — and a direct caller
      // could no longer catch it.
      //
      // Every failed validation keeps its error, not only a self-disposing one,
      // so a failure travels up a derived chain: the downstream computed's
      // recomputation reads this one, receives the error, fails, and keeps it
      // in turn, until a binding, effect or direct caller reads it.
      //
      // Bumping the version marks the value as changed, so the scheduler runs
      // the subscriber it was validating for. A live computed stays dirty and
      // recomputes on the read after the one that takes the error; a disposed
      // one is marked dirty only so readers check for the pending error.
      pendingError = { error: err };
      cs.__v++;
      if (disposed) cs._d = true;
      else cs._f = true;
    } finally {
      if (pushed) endDisposerCapture();
      evaluating = false;
      // The getter may have disposed this computed mid-run. `dispose()` already
      // released the edges that existed at that moment, but any source read
      // AFTER the call was linked by this very retrack — and its stale-dep pass
      // only prunes edges that were not re-read, so those survive it. Release
      // them now that the run is over, so a disposed computed holds no edges.
      if (disposed) cleanup(markDirty);
    }
    // A getter that disposed this computed has already emitted
    // `computed:destroy`; an update after it would describe a node DevTools no
    // longer tracks.
    if (hook && !disposed && !Object.is(oldValue, cs._v)) {
      emitDevtools(hook, "computed:update", { signal: cs, oldValue, newValue: cs._v });
    }
  };
  cs._validate = validate;

  // Hand the pending failure to exactly one reader. A disposed computed is
  // clean again afterwards and keeps returning its frozen value; a live one
  // stays dirty, so the next read retries.
  const throwPending = (): never => {
    const { error } = pendingError as { error: unknown };
    pendingError = undefined;
    if (disposed) cs._d = false;
    throw error;
  };

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
    if (isTrackingSuspended() || disposed) {
      if (cs._d) {
        validate();
        if (pendingError !== undefined) throwPending();
      }
      return cs._v;
    }

    // Settle BEFORE recording the edge. `recordDependency` stamps the edge with
    // `cs.__v`, and that stamp must describe the value we are about to return —
    // stamping a pre-recompute version would make the reader look permanently
    // stale and re-run it on every unrelated upstream write.
    if (cs._d) {
      validate();
      if (pendingError !== undefined) {
        // Record the edge BEFORE delivering the error. A reader that catches it
        // (a binding, `bindBoolAttr`) otherwise ends its run without having
        // re-read this computed, and `retrack`'s stale-dependency pass prunes
        // the edge — the reader never runs again when the sources recover.
        recordDependency(cs as ReactiveSignal);
        throwPending();
      }
    }
    recordDependency(cs as ReactiveSignal);
    return cs._v;
  }

  // Tag getter for devtools introspection
  if (debugName) {
    (computedGetter as unknown as Record<string, unknown>).__name = debugName;
    cs.__name = debugName;
  }
  (computedGetter as unknown as Record<string, unknown>).__signal = cs;

  (computedGetter as DerivedAccessor<T>).dispose = () => {
    if (disposed) return;
    disposed = true;
    // Clearing the dirty flag keeps the drain's stabilization check from
    // treating this computed as pending, and `cleanup` unlinks every source
    // edge so the sources stop retaining it. When called from inside this
    // computed's own recomputation, `validate()` runs `cleanup` once more after
    // the run, for edges the rest of the getter records.
    //
    // A failure still waiting for its reader keeps the flag set: readers only
    // look for a pending error on a dirty computed, so clearing it here would
    // make that error unreachable. `throwPending` clears it once delivered.
    cs._d = pendingError !== undefined;
    cleanup(markDirty);
    // Read the hook NOW, not the one captured at creation: DevTools may have
    // been attached (or detached) since, and its node inventory retains this
    // computed until it hears about the disposal.
    const h = (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
    if (h) {
      try {
        h.emit("computed:destroy", { signal: cs, getter: computedGetter });
      } catch {
        /* devtools hook errors should not break user teardown */
      }
    }
  };

  if (hook) emitDevtools(hook, "computed:create", { signal: cs, name: debugName, getter: computedGetter });

  // Created inside a render that later fails, the accessor never reaches its
  // owner; the render transaction disposes it on rollback instead.
  registerRollbackCleanup((computedGetter as DerivedAccessor<T>).dispose);
  return computedGetter as DerivedAccessor<T>;
}

/** Accessor returned by {@link derived}: read it like any getter, release it with `dispose()`. */
export type DerivedAccessor<T> = Accessor<T> & {
  /** Release every source subscription. The accessor then returns its last settled value. Idempotent. */
  dispose: () => void;
};
