/**
 * The hydration state the core needs: "is an adopting hydration in progress,
 * which one does the running code belong to, and what should run when it ends?"
 *
 * `hydrate(App, root, { strategy: "adopt" })` (in `sibujs/ssr`) opens a
 * session here while it binds the client tree to the server markup.
 * `ClientOnly` reads it: during the session it must render its server fallback
 * (so the fallback's server nodes are claimed instead of mismatching), and swap
 * in the real content once the session ends.
 *
 * Every hydration has its OWN session: its own pending work, its own waiters,
 * its own end callbacks. Two islands activating at once therefore end
 * independently — a fast one is not held by a slow one's chunk, and neither
 * can overwrite the other's wake-up. Work and callbacks are attributed to the
 * session whose adoption scope the code builds in (the scope's sink carries
 * it), or whose synchronous build or end callbacks are running. Work nothing
 * attributes holds every open session: releasing a session's unclaimed server
 * nodes before structural work that may be its own has landed would remove
 * server content.
 *
 * A hydration opened while another one's code runs (a nested `hydrate` inside
 * a build) is that one's child: the parent waits for it, and the child's end
 * callbacks run when the parent ends, as one session's would.
 *
 * Published on `globalThis` so a duplicate copy of the module (bundler
 * pre-bundling) sees the sessions another copy opened.
 */

import { currentSink } from "./adoptScope";

/** @internal */
export interface HydrationSession {
  /** Callbacks to run when the session ends. */
  done: Array<() => void>;
  /** Async work the adoption waits for (lazy chunks, route loads, nested hydrations). */
  pending: Set<object>;
  /** Waiters, each called whenever an entry leaves `pending`. */
  wake: Set<() => void>;
  /** The session this one was opened inside, which waits for it. */
  up: HydrationSession | null;
  open: boolean;
  /** Close the session and run (or hand to `up`) its callbacks; idempotent. */
  end(): void;
}

/** Open sessions, and the session whose synchronous code is running (`c`). */
const slot = ((globalThis as Record<symbol, { a: Set<HydrationSession>; c: HydrationSession | null } | undefined>)[
  Symbol.for("sibujs.hydration.v2")
] ??= { a: new Set(), c: null });

/** True while an adopting hydration is binding a client tree to server markup. */
export function isHydrating(): boolean {
  return slot.a.size > 0;
}

/** The session the running code is attributed to, open or not. */
function ownSession(): HydrationSession | null {
  return (currentSink()?.h as HydrationSession | undefined) ?? slot.c;
}

/**
 * The sessions the running code belongs to: its own (none once that one has
 * ended), or — when nothing attributes it — every open one.
 * @internal
 */
export function hydrationOwners(): HydrationSession[] {
  const own = ownSession();
  return own ? (own.open ? [own] : []) : Array.from(slot.a);
}

/**
 * Run `fn` when the current adopting hydration ends, or right away when none
 * is in progress. Runs exactly once, even when it has to wait for several
 * sessions.
 */
export function afterHydration(fn: () => void): void {
  const owners = hydrationOwners();
  let left = owners.length;
  const once = () => {
    if (--left < 1) fn();
  };
  if (left) for (const s of owners) s.done.push(once);
  else fn();
}

/** Call every waiter of `session` (each removes itself). */
function notify(session: HydrationSession): void {
  for (const wake of Array.from(session.wake)) wake();
}

/**
 * Register `entry` as work `sessions` wait for. Returns the function that
 * settles it, waking each session's waiters.
 * @internal
 */
export function holdHydration(sessions: HydrationSession[], entry: object): () => void {
  for (const s of sessions) s.pending.add(entry);
  return () => {
    for (const s of sessions) if (s.pending.delete(entry)) notify(s);
  };
}

/**
 * Run `fn` as code of `session` (attributing the work and callbacks it
 * registers outside any adoption scope).
 * @internal
 */
export function inHydration<T>(session: HydrationSession, fn: () => T): T {
  const prev = slot.c;
  slot.c = session;
  try {
    return fn();
  } finally {
    slot.c = prev;
  }
}

/**
 * Open a session. Its `end()` closes it and runs every callback registered
 * meanwhile — or, for a child session whose parent is still open, hands them
 * to the parent.
 * @internal
 */
export function beginHydration(): HydrationSession {
  const own = ownSession();
  const session: HydrationSession = {
    done: [],
    pending: new Set(),
    wake: new Set(),
    up: own?.open ? own : null,
    open: true,
    end() {
      if (!session.open) return;
      session.open = false;
      slot.a.delete(session);
      // Timed-out work is no longer waited for; a waiter still registered
      // (the build threw while one was pending) is released, timer and all.
      session.pending.clear();
      notify(session);
      const up = session.up;
      session.up = null;
      const callbacks = session.done.splice(0);
      if (up?.open) {
        up.done.push(...callbacks);
        if (up.pending.delete(session)) notify(up);
        return;
      }
      // Every callback runs even when one throws; the first error is rethrown.
      let failed = false;
      let error: unknown;
      inHydration(session, () => {
        for (const fn of callbacks) {
          try {
            fn();
          } catch (err) {
            if (!failed) error = err;
            failed = true;
          }
        }
      });
      if (failed) throw error;
    },
  };
  if (session.up) session.up.pending.add(session);
  slot.a.add(session);
  return session;
}
