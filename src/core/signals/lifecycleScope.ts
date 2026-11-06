import { bindOwnerScope, captureFrozen, type HeldCheck } from "../../reactivity/track";
import { type EffectBody, type EffectOptions, effect } from "./effect";
import { watch } from "./watch";

/** Where a {@link LifecycleScope} is in its life. */
export type LifecycleState = "active" | "paused" | "ended";

/**
 * The lifecycle a component was rendered in, captured so work created LATER —
 * after an `await` — can still belong to it. See {@link lifecycleScope}.
 *
 * Every registration made through it follows the same contract:
 *
 * - active: it behaves exactly like the plain primitive;
 * - paused: a new registration is created only when the lifecycle resumes; an
 *   existing one does not run, and what changed meanwhile is caught up in ONE
 *   run on resume, against the current state;
 * - ended: it is disposed — subscriptions released, cleanups run once — in
 *   the disposal that ends the lifecycle, before any other reactive work can
 *   run, and never runs again. A registration made after the end does nothing.
 *
 * Each method returns an idempotent disposer that works at any point: before
 * the registration was created (it then never is), while paused, or after.
 */
export interface LifecycleScope {
  /**
   * `"active"`: the subtree renders normally. `"paused"`: it is leaving (a
   * `when()` / `match()` branch playing its leave transition) and may still be
   * taken back. `"ended"`: it was released.
   */
  state(): LifecycleState;
  /**
   * `effect()`, owned by the captured lifecycle. Paused, changes are
   * coalesced into one run on resume (its cleanups first, as always).
   */
  effect(fn: EffectBody | (() => void), options?: EffectOptions): () => void;
  /**
   * `watch()`, owned by the captured lifecycle. It keeps `watch`'s contract —
   * `callback(current, previous)` when the getter's value changed, compared
   * with `Object.is` — so while paused the values in between are not
   * delivered: on resume the callback runs once, with the current value and
   * the last one it delivered, and not at all if the value came back to it.
   * Created while paused, it reads its initial value when the lifecycle
   * resumes.
   */
  watch<T>(getter: () => T, callback: (value: T, prev: T | undefined) => void): () => void;
  /**
   * The general form: run `register` as owned by the captured lifecycle and
   * dispose what it returns when the lifecycle ends. Every effect, watcher or
   * binding `register` creates synchronously is paused and resumed with the
   * lifecycle; the disposer it returns is called once — at the end, or by the
   * disposer this returns. Paused, `register` itself waits for the resume.
   *
   * If `register` throws, nothing is kept for it: the registration is rolled
   * back (its lifecycle listeners dropped) and the error is rethrown — or,
   * for a registration deferred to a resume, reported like an effect error.
   * Resources `register` acquired before throwing are its own to release:
   * it never returned the disposer that would have done it.
   */
  own(register: () => () => void): () => void;
  /**
   * Call `callback` each time the lifecycle pauses (a branch begins its leave,
   * a `KeepAliveRoute({ suspendInactive: true })` page is cached), a
   * microtask after it does. Reactive work owned by the scope pauses on its
   * own; this is for what does not — timers, sockets, media, requests — so it
   * can be suspended explicitly. Dropped when the lifecycle ends; returns a
   * function that drops it sooner.
   */
  onPause(callback: () => void): () => void;
  /** Call `callback` each time the lifecycle resumes after a pause; see {@link onPause}. */
  onResume(callback: () => void): () => void;
}

const STATES: readonly LifecycleState[] = ["active", "paused", "ended"];
const ENDED = 2;
const NOOP = (): void => {};

// The captured owner behind each scope, for `pendingContent(scope)`.
const scopeOwners = new WeakMap<LifecycleScope, HeldCheck>();

/** The owner check a scope captured. @internal */
export function scopeOwner(scope: LifecycleScope): HeldCheck | undefined {
  return scopeOwners.get(scope);
}

/**
 * Capture the current lifecycle — the structural owner and route scope the
 * calling code renders in — for work created after an `await`.
 *
 * An `effect()` or `watch()` called after an `await` runs outside the render
 * that started the work, so it belongs to no lifecycle: it keeps running while
 * its component's branch is paused for a leave transition, and only a
 * disposer you registered yourself stops it. Nothing can find it from the
 * outside either: it has no DOM node, so holding a detached subtree does not
 * reach it, and registering its disposer on a node gives teardown, not
 * ownership. Capture the lifecycle synchronously, before the first `await`,
 * and create the work through it:
 *
 * ```ts
 * function Profile(id: string) {
 *   const scope = lifecycleScope();          // during render
 *   const el = div("loading…");
 *   load(id).then((user) => {
 *     scope.effect(() => {                   // owned by Profile's lifecycle
 *       el.textContent = `${user.name} (${status()})`;
 *     });
 *     scope.watch(() => user.online(), (online) => notify(online));
 *   });
 *   return el;
 * }
 * ```
 *
 * Nothing is installed globally across the `await`: each scope is an explicit
 * object, so concurrent work never inherits another's lifecycle.
 *
 * Which lifecycle is captured:
 * - in a `when()` / `match()` branch the directive built, the branch's: it
 *   ends when the branch is replaced — at the switch, or with a `transition`
 *   when its leave ends; it pauses while the branch leaves and resumes if the
 *   branch is taken back. A bare node handed to the directive is the
 *   caller's, so the scope is that of the code that built it;
 * - in a route component (cached, lazy, unwrapped from a module), the route
 *   instance's: it ends when the instance is replaced or disposed, and pauses
 *   with the branch holding the outlet — and, with
 *   `KeepAliveRoute({ suspendInactive: true })`, while the page is cached;
 * - in `Suspense`'s `nodes()` (or `fallback`), the boundary's content (or
 *   fallback): it ends with the boundary (or when the fallback is replaced);
 * - outside any render: none. The scope is always active and never ends; its
 *   registrations behave like the plain primitives.
 *
 * Only what goes through the scope is owned. An `effect()` created after an
 * `await` without it is unowned, and stays so: nothing is installed across
 * the `await`, and ownership is never inferred from what rendered last.
 * `registerDisposer(node, stop)` gives such work teardown with that node, not
 * pause and resume.
 *
 * @returns The captured {@link LifecycleScope}.
 */
export function lifecycleScope(): LifecycleScope {
  const held = captureFrozen();
  // The route scope (and any other owner scope) the render ran in, too.
  const inOwnerScope = bindOwnerScope((create: () => () => void) => create());
  const ended = (): boolean => held.state() === ENDED;

  const own = (register: () => () => void): (() => void) => {
    let disposed = false;
    let stop: (() => void) | null = null;
    let dropWait = NOOP;
    let dropEnd = NOOP;
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      dropWait();
      dropEnd();
      const running = stop;
      stop = null;
      running?.();
    };
    const start = (): void => {
      dropWait = NOOP;
      if (disposed) return;
      // Watched FIRST: an end during `register` (its first run may switch the
      // branch away) disposes what it created as soon as it returns.
      dropEnd = held.onEnd(dispose);
      if (disposed) return;
      let created: () => void;
      try {
        created = held.run(() => inOwnerScope(register));
      } catch (err) {
        // Nothing was created that this registration could dispose: roll it
        // back, so no listener outlives it.
        disposed = true;
        dropEnd();
        dropEnd = NOOP;
        throw err;
      }
      if (disposed) created();
      else stop = created;
    };
    const state = held.state();
    if (state === ENDED) disposed = true;
    else if (state === 1) dropWait = held.wait(start, dispose);
    else start();
    return dispose;
  };

  const onState = (want: number, callback: () => void): (() => void) =>
    held.onChange((state) => {
      if (state === want) callback();
    });

  const scope: LifecycleScope = {
    state: () => STATES[held.state()],
    own,
    onPause: (callback) => onState(1, callback),
    onResume: (callback) => onState(0, callback),
    // The guards are the liveness check of a registration whose owner ended
    // while its own run was in progress (a body that ends its branch and
    // re-runs itself); `own` disposes it as soon as that run returns.
    effect: (fn, options) =>
      own(() =>
        effect((onCleanup) => {
          if (!ended()) (fn as EffectBody)(onCleanup);
        }, options),
      ),
    watch: (getter, callback) =>
      own(() =>
        watch(getter, (value, prev) => {
          if (!ended()) callback(value, prev);
        }),
      ),
  };
  scopeOwners.set(scope, held);
  return scope;
}
