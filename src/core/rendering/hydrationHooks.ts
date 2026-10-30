/**
 * The one piece of hydration state the core needs: "is an adopting hydration
 * in progress, and what should run when it ends?"
 *
 * `hydrate(App, root, { strategy: "adopt" })` (in `sibujs/ssr`) opens a
 * session here while it binds the client tree to the server markup.
 * `ClientOnly` reads it: during the session it must render its server fallback
 * (so the fallback's server nodes are claimed instead of mismatching), and swap
 * in the real content once the session ends.
 *
 * A single slot, so the core pays one property read when no session exists
 * and none of the adoption machinery ships in the core. Published on
 * `globalThis` so a duplicate copy of the module (bundler pre-bundling) sees
 * the session the other copy opened.
 */

interface HydrationSession {
  done: Array<() => void>;
  /** Async work the adoption waits for (lazy chunks, route loads), by label. */
  pending: Set<{ label: string }>;
  /** Called when an entry leaves `pending`. */
  wake: (() => void) | null;
}

const slot = ((globalThis as Record<symbol, { s: HydrationSession | null } | undefined>)[
  Symbol.for("sibujs.hydration.v1")
] ??= { s: null });

/** True while an adopting hydration is binding the client tree to server markup. */
export function isHydrating(): boolean {
  return slot.s !== null;
}

/**
 * Run `fn` when the current adopting hydration ends, or right away when none
 * is in progress.
 */
export function afterHydration(fn: () => void): void {
  if (slot.s) slot.s.done.push(fn);
  else fn();
}

/**
 * Open a session. Returns the function that closes it and runs every callback
 * registered meanwhile. Nested sessions share the outermost one.
 * @internal
 */
export function beginHydration(): () => void {
  if (slot.s) return () => {};
  const session: HydrationSession = { done: [], pending: new Set(), wake: null };
  slot.s = session;
  return () => {
    if (slot.s !== session) return;
    slot.s = null;
    for (const fn of session.done) fn();
  };
}

/**
 * The open session's pending-work registry, for `trackPending` (browser side)
 * and the adoption's settle loop.
 * @internal
 */
export function hydrationPending(): Pick<HydrationSession, "pending" | "wake"> | null {
  return slot.s;
}
