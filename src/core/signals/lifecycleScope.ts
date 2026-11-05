import { bindOwnerScope, captureFrozen } from "../../reactivity/track";
import { type EffectBody, type EffectOptions, effect } from "./effect";

/** Where a {@link LifecycleScope} is in its life. */
export type LifecycleState = "active" | "paused" | "ended";

/**
 * The lifecycle a component was rendered in, captured so work created LATER —
 * after an `await` — can still belong to it. See {@link lifecycleScope}.
 */
export interface LifecycleScope {
  /**
   * `"active"`: the subtree renders normally. `"paused"`: it is leaving (a
   * `when()` / `match()` branch playing its leave transition) and may still be
   * taken back. `"ended"`: it was released.
   */
  state(): LifecycleState;
  /**
   * `effect()`, owned by the captured lifecycle:
   *
   * - active: it runs as any effect does;
   * - paused: a new effect's first run waits for the resume; an existing one
   *   does not run, and changes made meanwhile are coalesced into ONE run on
   *   resume, against the current state (its cleanups first, as always);
   * - ended: it never runs again; it is disposed — subscriptions released,
   *   cleanups run once — when the lifecycle ends.
   *
   * The returned disposer works at any point, including before the first run.
   */
  effect(fn: EffectBody | (() => void), options?: EffectOptions): () => void;
}

const STATES: readonly LifecycleState[] = ["active", "paused", "ended"];

/**
 * Capture the current lifecycle — the structural owner and route scope the
 * calling code renders in — for work created after an `await`.
 *
 * An `effect()` called after an `await` runs outside the render that started
 * the work, so it belongs to no lifecycle: it keeps running while its
 * component's branch is paused for a leave transition, and only a disposer
 * you registered yourself stops it. Its DOM cannot be found from the outside
 * either — registering a disposer on a node gives teardown, not ownership.
 * Capture the lifecycle synchronously, before the first `await`, and create
 * the effect through it:
 *
 * ```ts
 * function Profile(id: string) {
 *   const scope = lifecycleScope();          // during render
 *   const el = div("loading…");
 *   load(id).then((user) => {
 *     scope.effect(() => {                   // owned by Profile's lifecycle
 *       el.textContent = `${user.name} (${status()})`;
 *     });
 *   });
 *   return el;
 * }
 * ```
 *
 * Nothing is installed globally across the `await`: each scope is an explicit
 * object, so concurrent work never inherits another's lifecycle.
 *
 * Ending follows the structural owner. A `when()` / `match()` branch with a
 * `transition` has its own owner, which ends when the branch is released;
 * without a transition the owner is the directive itself, so tie an effect to
 * the DOM it serves with `registerDisposer(node, scope.effect(…))` when it
 * must stop with that DOM. Captured outside any render, the scope is always
 * active and never ends: its effects behave like plain `effect()`s.
 *
 * @returns The captured {@link LifecycleScope}.
 */
export function lifecycleScope(): LifecycleScope {
  const held = captureFrozen();
  // The route scope (and any other owner scope) the render ran in, too.
  const inOwnerScope = bindOwnerScope((create: () => void) => create());
  return {
    state: () => STATES[held.state()],
    effect: (fn, options) => {
      let disposed = false;
      let stop: (() => void) | null = null;
      let dropWait = (): void => {};
      let dropEnd = (): void => {};
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
        if (disposed) return;
        held.run(() =>
          inOwnerScope(() => {
            stop = effect(fn, options);
          }),
        );
        dropEnd = held.onEnd(dispose);
      };
      const state = held.state();
      if (state === 2) disposed = true;
      else if (state === 1) dropWait = held.wait(start, dispose);
      else start();
      return dispose;
    },
  };
}
