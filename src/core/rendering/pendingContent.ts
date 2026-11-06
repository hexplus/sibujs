import { type LifecycleScope, scopeOwner } from "../signals/lifecycleScope";
import { isServer } from "../ssr-context";
import { registerDisposer, unregisterDisposer } from "./dispose";
import { beginPending } from "./range";

/** A registration made by {@link pendingContent}. */
export interface PendingContent {
  /**
   * The content is committed: settle the registration. Call it AFTER the
   * content is in the DOM — readiness means "on the page", not "the request
   * returned". `committed` names what joins a running enter; by default it is
   * what the location renders then (the children of an element, the range
   * after an anchor). A failure that commits an error view settles the same
   * way, with that view.
   */
  done(committed?: Node | readonly Node[]): void;
  /**
   * The operation was cancelled or superseded: settle WITHOUT content.
   * Nothing joins a running enter for it — not even what its location shows
   * now (a loading placeholder). Disposing the location, or the end of the
   * lifecycle it was registered on, cancels it the same way.
   */
  cancel(): void;
  /** Whether it has settled (done, cancelled, or dropped with its location). */
  readonly settled: boolean;
}

const INERT: PendingContent = { done: () => {}, cancel: () => {}, settled: true };

/**
 * Register content that will arrive later, so a `when()` / `match()` enter
 * with `waitForContent` waits for it. Nothing becomes pending on its own — a
 * `fetch`, a promise or an `asyncDerived` is not tracked until the application
 * says so here — and each call is one independent registration: several at
 * the same location stay pending until each one settles, and settling one
 * (a stale request completing late) never settles another.
 *
 * `at` places it:
 * - a node (an element, or a range anchor): it takes part in an enter while
 *   the node lies inside the entering branch. Moving it into the branch, or
 *   out of it, while the enter waits is noticed when it happens: attached, it
 *   holds the enter (and its content joins when it is done); removed, it no
 *   longer does. Disposing the node cancels it;
 * - a {@link LifecycleScope}: it takes part when that lifecycle lies inside
 *   the entering branch (captured in it, or in a route instance or `Suspense`
 *   below it). The lifecycle ending cancels it. This is the form to use when
 *   the content is pending BEFORE the node it will render into exists — a
 *   component that starts a request, then builds its DOM when it returns:
 *   capture the scope while rendering and register on it. A scope captured
 *   outside any render belongs to no branch and never ends: a registration
 *   on it holds no enter, and stays until it is settled.
 *
 * Settle it exactly when the outcome is committed: `done()` after inserting
 * the content (or an error view), `cancel()` when the operation is abandoned
 * or superseded — a cancelled registration enrolls nothing in the enter. Both
 * are idempotent; the first call wins, so a stale `done()` after a
 * `cancel()` (or after the location was disposed) does nothing. A registration
 * made while an enter is waiting is picked up by it, but the enter's
 * deadline, fixed at the switch, never moves: content committed later
 * appears without an enter.
 *
 * Server renders play no transitions: there it registers nothing and returns
 * an inert handle (already settled), so the same code runs in both places.
 *
 * ```ts
 * function Results(query: string) {
 *   const list = ul({ class: "results" }, li("Loading…"));
 *   const pending = pendingContent(list);
 *   fetch(`/api/search?q=${query}`)
 *     .then((r) => r.json())
 *     .then((rows) => {
 *       list.replaceChildren(...rows.map((row) => li(row.title)));
 *       pending.done();                       // committed: the rows join the enter
 *     })
 *     .catch((err) => {
 *       list.replaceChildren(li({ class: "error" }, String(err)));
 *       pending.done();                       // the error view is the outcome
 *     });
 *   return list;
 * }
 * ```
 *
 * Content driven by reactive state is committed by its bindings; settle once
 * the state that feeds them has arrived. Readiness is read a microtask after
 * `done()`, after the bindings of the same update have run:
 *
 * ```ts
 * function Profile() {
 *   const scope = lifecycleScope();
 *   const user = asyncDerived(() => loadUser(), null);
 *   const card = div({ class: "card" }, () => user.value()?.name ?? "Loading…");
 *   const pending = pendingContent(card);
 *   scope.watch(() => user.loading(), (loading) => {
 *     if (!loading) pending.done();           // value (or error) rendered
 *   });
 *   scope.own(() => user.dispose);
 *   return card;
 * }
 * ```
 *
 * @param at The node, range anchor or captured lifecycle the content belongs to.
 * @returns The registration's handle.
 */
export function pendingContent(at: Node | LifecycleScope): PendingContent {
  if (isServer()) return INERT;
  const isNode = typeof (at as Node).nodeType === "number";
  const held = isNode ? null : (scopeOwner(at as LifecycleScope) ?? null);
  if (!isNode && (held === null || held.state() === 2)) return INERT;
  const { entry, done, cancel: cancelEntry } = beginPending(isNode ? (at as Node) : null, held);
  let drop = (): void => {};
  // Cancellation — explicit, or the location going away — enrolls nothing:
  // what the location renders then is not the outcome.
  const cancel = (): void => {
    if (entry.settled) return;
    drop();
    cancelEntry();
  };
  if (isNode) {
    registerDisposer(at as Node, cancel);
    drop = () => {
      unregisterDisposer(at as Node, cancel);
    };
  } else drop = (held as NonNullable<typeof held>).onEnd(cancel);
  return {
    done: (committed) => {
      if (entry.settled) return;
      drop();
      done(
        committed === undefined
          ? null
          : typeof (committed as Node).nodeType === "number"
            ? [committed as Node]
            : [...(committed as readonly Node[])],
      );
    },
    cancel,
    get settled() {
      return entry.settled;
    },
  };
}
