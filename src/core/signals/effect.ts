import { cleanup as coreCleanup, retrack, untracked } from "../../reactivity/track";
import { devAssert } from "../dev";
import { isSSR } from "../ssr-context";

/** Options for effect */
export interface EffectOptions {
  /** Error handler for exceptions thrown during effect execution. */
  onError?: (error: unknown) => void;
}

const _g = globalThis as any;

/**
 * Creates a callback that only tracks the specified dependencies,
 * running the handler in an untracked context. Use with `effect()`
 * to control exactly which signals trigger re-execution.
 *
 * @param deps Getter(s) whose return values are tracked as dependencies
 * @param handler Called with the current dependency value(s) whenever they change
 * @returns A function suitable for passing to `effect()`
 *
 * @example
 * ```ts
 * const [count, setCount] = signal(0);
 * const [label, setLabel] = signal("clicks");
 *
 * // Only re-runs when count changes, NOT when label changes
 * effect(on(() => count(), (c) => {
 *   console.log(`${c} ${label()}`);  // label() read but not tracked
 * }));
 * ```
 */
export function on<T>(deps: () => T, handler: (value: T, prev: T | undefined) => void): () => void {
  let prev: T | undefined;
  let first = true;

  return () => {
    const value = deps();
    if (first) {
      first = false;
      prev = value;
      untracked(() => handler(value, undefined));
    } else {
      const p = prev;
      prev = value;
      untracked(() => handler(value, p));
    }
  };
}

/** Registers a function to run before the effect re-runs or is disposed.
 *  Called with the same signature inside every invocation. */
export type OnCleanup = (fn: () => void) => void;

/** The user's effect body — may accept an `onCleanup` callback to register
 *  teardown that runs before the next re-run or on dispose. */
export type EffectBody = (onCleanup: OnCleanup) => void;

// ---------------------------------------------------------------------------
// Effect implementation — context-object design.
//
// Each `effect()` call allocates ONE `EffectCtx` plus three closures:
//   - ctx.onCleanup   (user-exposed, captures ctx)
//   - ctx.subscriber  (tracking entry point, captures ctx)
//   - the returned dispose handle (captures ctx)
//
// Every other function is module-level — a single shared instance that reads
// per-effect state out of the passed ctx. Previously we allocated six closures
// per effect (onCleanup, flushUserCleanups, wrappedFn, drainReruns,
// subscriber, dispose). For the Memory benchmark (25 000 effect creations per
// run) this saves ~75 000 closure allocations, a measurable chunk of GC.
// ---------------------------------------------------------------------------

// Safety cap — if an effect keeps requesting re-runs, bail rather than loop
// forever. Matches the spirit of drainNotificationQueue's cap.
const MAX_RERUNS = 100;

interface EffectCtx {
  fn: EffectBody | (() => void);
  onError: ((err: unknown) => void) | undefined;
  userCleanups: Array<() => void>;
  running: boolean;
  rerunPending: boolean;
  disposed: boolean;
  onCleanup: OnCleanup;
  subscriber: () => void;
  // Pre-allocated body closure passed to track(). Allocated ONCE at effect
  // creation and reused across every invocation — avoids allocating a fresh
  // `() => runBody(ctx)` on every re-run, which for a 10k-invocation
  // workload would cost ~10k closure allocations.
  bodyFn: () => void;
}

function flushUserCleanups(ctx: EffectCtx): void {
  const list = ctx.userCleanups;
  if (list.length === 0) return;
  ctx.userCleanups = [];
  for (let i = list.length - 1; i >= 0; i--) {
    try {
      list[i]();
    } catch (err) {
      if (typeof console !== "undefined") console.warn("[SibuJS effect] onCleanup threw:", err);
    }
  }
}

// Cold path: an effect wrote to a signal it depends on mid-body, triggering
// rerunPending. Loop until stable or the safety cap trips. Kept module-level
// because it's rare and larger than the hot path.
function drainReruns(ctx: EffectCtx): void {
  let reruns = 1;
  do {
    ctx.rerunPending = false;
    if (ctx.userCleanups.length > 0) flushUserCleanups(ctx);
    retrack(ctx.bodyFn, ctx.subscriber);
  } while (ctx.rerunPending && ++reruns <= MAX_RERUNS);
  if (ctx.rerunPending) {
    ctx.rerunPending = false;
    if (_g.__SIBU_DEV_WARN__ !== false && typeof console !== "undefined") {
      console.error(
        `[SibuJS] effect re-requested itself ${MAX_RERUNS}+ times — ` +
          "likely a write-reads-self cycle. Breaking to prevent infinite loop.",
      );
    }
  }
}

function disposeEffect(ctx: EffectCtx): void {
  // Idempotent — user code composing disposers (Array.push(dispose)) may
  // inadvertently call twice. Second call should be a no-op.
  if (ctx.disposed) return;
  ctx.disposed = true;
  const h = _g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  if (h) {
    try {
      h.emit("effect:destroy", { effectFn: ctx.fn });
    } catch {
      /* devtools hook errors should not break user teardown */
    }
  }
  try {
    if (ctx.userCleanups.length > 0) flushUserCleanups(ctx);
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[SibuJS effect] onCleanup threw during dispose:", err);
    }
  }
  try {
    // Call core cleanup directly on the subscriber — no per-subscriber
    // closure allocation, which matters when many effects are disposed
    // in bulk (Memory benchmark).
    coreCleanup(ctx.subscriber);
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[SibuJS effect] dispose threw:", err);
    }
  }
}

/**
 * effect runs the provided effectFn immediately and re-runs it whenever
 * any reactive dependency changes.
 * Returns a cleanup function to stop further executions.
 *
 * In SSR mode, effect is a no-op — side effects should not run on the server.
 *
 * @example addEventListener pattern with built-in teardown:
 * ```ts
 * effect((onCleanup) => {
 *   const handler = (e: Event) => { ... };
 *   window.addEventListener("resize", handler);
 *   onCleanup(() => window.removeEventListener("resize", handler));
 * });
 * ```
 */
export function effect(effectFn: EffectBody | (() => void), options?: EffectOptions): () => void {
  devAssert(typeof effectFn === "function", "effect: argument must be a function.");

  // No-op during SSR — side effects are client-only
  if (isSSR()) return () => {};

  // Allocate a single per-effect state object. All per-effect state lives
  // here; module-level helper functions receive `ctx` as their only
  // argument. Pre-initialized to keep the hidden class stable.
  const ctx: EffectCtx = {
    fn: effectFn,
    onError: options?.onError,
    userCleanups: [],
    running: false,
    rerunPending: false,
    disposed: false,
    onCleanup: null as unknown as OnCleanup,
    subscriber: null as unknown as () => void,
    bodyFn: null as unknown as () => void,
  };
  ctx.onCleanup = (fn) => {
    ctx.userCleanups.push(fn);
  };

  // Pre-allocated body closure passed to track(). Logic is inlined instead
  // of delegating to a module-level `runBody(ctx)` — saves one function
  // frame per effect invocation on the hot path.
  const onErrorCaptured = ctx.onError;
  ctx.bodyFn = onErrorCaptured
    ? () => {
        try {
          (ctx.fn as EffectBody)(ctx.onCleanup);
        } catch (err) {
          onErrorCaptured(err);
        }
      }
    : () => {
        (ctx.fn as EffectBody)(ctx.onCleanup);
      };

  // Subscriber closure with runSubscriber's hot-path logic INLINED. Same
  // allocation count as before (one closure per effect), but one fewer
  // function frame per invocation. For Cascading (4000 invocations / run)
  // this shaves ~60 µs; for Memory (50k invocations / run) ~750 µs.
  //
  // Fields are set explicitly after allocation so every effect subscriber
  // gets the same hidden class, keeping V8's inline caches monomorphic in
  // track / cleanup / recordDep.
  const sub = (() => {
    if (ctx.running) {
      ctx.rerunPending = true;
      return;
    }
    ctx.running = true;
    try {
      ctx.rerunPending = false;
      if (ctx.userCleanups.length > 0) flushUserCleanups(ctx);
      // `retrack()` reuses stable dep edges via epoch tagging — for
      // effects with unchanging deps (the common case) it skips the
      // unlink/alloc/relink cycle that `track()` does every invocation.
      // Conditional-dep effects still work: deps not re-read this run get
      // pruned at end of retrack via epoch mismatch.
      retrack(ctx.bodyFn, sub);
      if (ctx.rerunPending) drainReruns(ctx);
    } finally {
      ctx.running = false;
      ctx.rerunPending = false;
    }
  }) as (() => void) & {
    depsHead: null;
    depsTail: null;
    _epoch: number;
    _structDirty: boolean;
    _runEpoch: number;
    _runs: number;
    _dispose?: () => void;
  };
  sub.depsHead = null;
  sub.depsTail = null;
  sub._epoch = 0;
  sub._structDirty = false;
  sub._runEpoch = 0;
  sub._runs = 0;
  ctx.subscriber = sub;

  // Initial run — take the happy path directly (no cleanup, no userCleanups).
  ctx.running = true;
  try {
    retrack(ctx.bodyFn, ctx.subscriber);
    if (ctx.rerunPending) drainReruns(ctx);
  } finally {
    ctx.running = false;
    ctx.rerunPending = false;
  }

  const hook = _g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  if (hook) hook.emit("effect:create", { effectFn });

  return () => disposeEffect(ctx);
}
