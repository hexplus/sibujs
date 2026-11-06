import {
  bindOwnerScope,
  captureFrozen,
  holdSubtree,
  reactiveBinding,
  structuralBinding,
  untracked,
} from "../../reactivity/track";
import type { StructuralBinding } from "../../reactivity/track-core";
import { devWarnLazy } from "../dev";
import { reportError } from "../errors";
import { isServer } from "../ssr-context";
import { captureScope, inScope } from "./adoptScope";
import { type DirectiveTransition, HARD_CAP_MS, now, type PhaseRun, runPhase } from "./branchTransition";
import { dispose, registerDisposer } from "./dispose";
import { captureFocusWithin, type FocusPolicy, type FocusSnapshot, restoreFocusWithin } from "./focusPreservation";
import {
  anyPending,
  collectRange,
  hasRange,
  loadingWithin,
  onLoaded,
  type Pending,
  pendingWithin,
  queueFirstRender,
  registerRange,
  resumePending,
  settledContent,
  settledSinceNotify,
} from "./range";
import { requireDocument } from "./requireDocument";
import type { NodeChild } from "./types";

export type { DirectiveTransition } from "./branchTransition";

/**
 * Conditional rendering directive. Shows or hides an element reactively.
 * Unlike `when()`, the element is always created — it just toggles display.
 *
 * Accepts the element either directly or as a thunk, so the same call shape
 * works here and in {@link when}. Which one you pass changes nothing: `show`
 * never rebuilds, so a thunk is invoked exactly once, immediately.
 *
 * @param condition Reactive getter returning boolean
 * @param element The element to show/hide, or a function returning it
 * @returns The element itself (not a wrapper), with a reactive display binding.
 * The caller keeps the live node and can mutate it or attach listeners to it.
 *
 * @example
 * ```ts
 * const [visible, setVisible] = signal(true);
 * div([show(() => visible(), span("I toggle!"))]);
 * div([show(() => visible(), () => span("also fine"))]);
 * ```
 *
 * TRAP — `show` keeps the element in the DOM and toggles `display`. Use
 * {@link when} when the content must not exist at all while hidden (an
 * expensive subtree, or one whose mere presence is observable). Note that
 * `when` REBUILDS on every condition change, which discards focus and
 * selection inside the branch — see the note on `when`.
 */
export function show<T extends Element>(condition: () => boolean, element: T | (() => T)): T {
  // Widened from `element: T`. `when` took thunks while `show` took an element,
  // so passing one API's shape to the other failed — silently for `when`, and
  // for `show` as a `TypeError` about `style` on `undefined` raised from inside
  // the directive rather than at the call site. Both shapes work in both places
  // now, which removes the mistake rather than reporting it.
  const resolved: T = typeof element === "function" ? (element as () => T)() : element;
  const update = () => {
    (resolved as unknown as HTMLElement).style.display = condition() ? "" : "none";
  };
  // Register the teardown on the element so disposing the element (e.g. when an
  // enclosing each/when row is removed) also stops the condition subscription.
  // Without this the effect — and everything it closes over — leaks forever.
  //
  // `reactiveBinding(update, node)` rather than a bare `track(update)`: both
  // create the same subscriber, but only this form stamps the owning node on it.
  // A condition that throws on a LATER scheduled run is reported from the
  // drain, which finds the enclosing ErrorBoundary only through that node (see
  // the note above the class/style bindings in tagFactory.ts).
  registerDisposer(resolved, reactiveBinding(update, resolved));
  return resolved;
}

/**
 * Options accepted by {@link when} and {@link match}.
 */
export interface DirectiveOptions {
  /**
   * What a rebuild does with focus it discarded (see `FocusPolicy`):
   * `"preserve"` (default) restores it by identity and warns in dev when it
   * cannot; `"discard"` drops it silently because that is intended;
   * `{ restoreTo }` sends it to the given element (or getter) instead of
   * `<body>` when the rebuilt branch has no counterpart.
   */
  focus?: FocusPolicy;
  /**
   * Animate branch changes. Without it (the default) the outgoing branch is
   * removed and disposed at the moment of the switch.
   *
   * ```ts
   * when(() => step() === "done", () => Done(), () => Generating(), {
   *   transition: { enterClass: "fade-in", leaveClass: "fade-out" },
   * });
   * ```
   *
   * With a transition, at the switch the outgoing branch:
   * - is FROZEN: its reactive bindings and effects stop, so it keeps showing
   *   its last state instead of reacting to state the new branch now owns;
   * - gets `inert` and `aria-hidden="true"`, so it cannot be clicked or
   *   focused while it fades (focus inside it follows the `focus` policy, as
   *   on any rebuild);
   * - plays its leave (`leaveClass`, or a custom `leave`) where it is in the
   *   DOM, and is removed and disposed when that ends: once every animation
   *   and transition its elements actually started has finished (read with
   *   `getAnimations()`; end events where it is missing), when the custom
   *   `leave` promise settles, or at a timeout computed from its styles,
   *   capped by `maxDuration` and never more than 5 s. Zero durations (no animation, a
   *   reduced-motion stylesheet, `display: none`) remove it synchronously.
   *
   * Its `onUnmount` callbacks and `registerDisposer` teardowns run when it is
   * actually removed, so a component can keep a canvas or a
   * `requestAnimationFrame` loop running until it has faded out.
   *
   * Switching again while a branch is leaving does not interrupt it; several
   * branches may be leaving at once. Switching back to a bare element (or
   * fragment) branch that is still leaving cancels its leave and re-attaches
   * it. The first render plays no enter unless `appear: true`. An enter waits
   * for the first render of a top-level `each()` or nested directive (a few
   * microtask turns at most), so those rows enter with the branch; rows such a
   * range adds while a class-based enter runs join it, and rows it adds while
   * the branch leaves join the leave. Content that arrives later (a
   * `Suspense` boundary, a route outlet, a `pendingContent()` registration)
   * is not waited for unless `waitForContent` says how long to wait.
   * Disposing the directive removes leaving branches at once. Server renders
   * ignore transitions entirely.
   *
   * A branch the directive built has its own lifecycle either way (see
   * `lifecycleScope`): without a transition it ends at the switch, with one it
   * pauses for the leave and ends when the branch is released.
   */
  transition?: DirectiveTransition;
}

/**
 * A plain object in a branch position is the options bag: no `NodeChild` is a
 * plain object (nodes, primitives, functions, null/undefined only).
 */
function isDirectiveOptions(value: unknown): value is DirectiveOptions {
  return typeof value === "object" && value !== null && !(value instanceof Node);
}

/**
 * One rendered branch of a `when` / `match`.
 *
 * A branch may be several nodes: a `DocumentFragment` empties itself when it is
 * inserted, so its child nodes are recorded before insertion and the branch is
 * released through them, not through the (by then empty) fragment. And a
 * branch is a RANGE: a start that renders siblings of its own (an `each()`
 * anchor, a nested `when` / `match`, a `Fragment` function child) brings
 * everything it renders now, which `refreshNodes` re-reads before the branch is
 * made inert, animated, removed or re-attached.
 */
interface Branch {
  /** The node the branch resolved to: an element, a text node, or a fragment. */
  source: Node;
  /** The nodes it was inserted as: the fragment's children, or `[source]`. */
  starts: Node[];
  /** Every node it occupies after the anchor, as of the last `refreshNodes`. */
  nodes: Node[];
  /** Whether the directive produced it (and so disposes it). See `resolveBranch`. */
  owned: boolean;
  /**
   * The structural owner its subscribers were created under: the branch's
   * lifecycle (see `lifecycleScope`). Every branch the directive built has
   * one, with or without a transition; a bare branch has one only while it is
   * leaving after it was taken back (it keeps the one it was reclaimed with).
   */
  owner: StructuralBinding | null;
  /** Transitions only: the enter or leave in progress. */
  phase: PhaseRun | null;
  /** Transitions only: undoes the `inert` / `aria-hidden` a leave applied. */
  restore: (() => void) | null;
  /** Transitions only: releases the hold a leave put on the branch's DOM. */
  unhold: (() => void) | null;
  /** Transitions only (`in-out`): leaving, but waiting for the new branch's enter. */
  waiting: boolean;
  /**
   * Released (see `releaseBranch`): terminal. Application code a switch runs
   * (a factory, a transition callback, a `connectedCallback`, a cleanup) may
   * dispose the directive, whose teardown releases every branch it holds;
   * the switch that was running finds this set and does nothing more to it.
   */
  released: boolean;
  /**
   * Being inserted: `nodes` is the complete list it is inserted as, some of
   * it possibly not inserted yet. A teardown during the insertion releases
   * all of it (see `refreshNodes`).
   */
  inserting: boolean;
}

// A fragment's child nodes, recorded when it was first inserted: insertion
// empties it, and a bare fragment (one handed in rather than built) is
// re-attached through them.
const fragmentStarts = new WeakMap<Node, Node[]>();
// The nodes a bare branch occupies (its range, with whatever an `each()` or
// nested directive in it rendered), as of its last refresh: taking back a bare
// branch that is still leaving re-inserts all of them.
const detachedRanges = new WeakMap<Node, Node[]>();
// Where a hidden bare branch with a range is parked: a detached fragment, so
// its `each()` / nested directives still have a parent and keep reconciling
// while it is off the page. Re-attaching takes the fragment's CURRENT content.
const parked = new WeakMap<Node, DocumentFragment>();

// How many microtask turns an enter waits for nested first renders (a nested
// directive's branch can hold another renderer that renders a turn later).
// Bounded, so content that never renders cannot hold the enter.
const ENTER_WAIT_TURNS = 8;

const NOOP = (): void => {};

/**
 * Resolve one branch of `when`/`match` to its nodes, and decide whether the
 * calling directive OWNS them.
 *
 * Ownership decides disposal, and getting it wrong is silent in both
 * directions: dispose a node the caller still holds and its reactive bindings
 * die with no error; fail to dispose one nobody else references and its
 * bindings leak. The rule is that a directive owns only what it produced —
 * a node returned by a factory, or a text node built from a primitive.
 *
 * A factory that closes over ONE element and returns it every time (`() => el`)
 * is the element form wearing a function's clothes. It is detected on the
 * second attach and demoted to unowned, which stops repeated disposal; the
 * first switch-away has already disposed it, so the dev warning names the fix.
 */
function resolveBranch(branch: NodeChild, attachedOnce: WeakSet<Node>, where: string): Branch | null {
  // A function branch is a FACTORY and is invoked; anything else is already
  // the content. `NodeChild` includes `() => NodeChild`, so this one check
  // covers thunks, accessors, elements, strings and numbers alike.
  const result = typeof branch === "function" ? (branch as () => NodeChild)() : branch;
  if (result == null || typeof result === "boolean") return null;

  const node = result instanceof Node ? result : document.createTextNode(String(result));
  const handedIn = node === (branch as unknown as Node);
  const seenBefore = attachedOnce.has(node);
  const owned = !handedIn && !seenBefore;

  // Recorded unconditionally. Ownership must not depend on the build mode: if
  // this bookkeeping were dev-only, a `() => stableEl` factory would be treated
  // as unowned in dev and disposed in production — the worst kind of bug, one
  // that only exists in the build nobody debugs.
  attachedOnce.add(node);

  if (seenBefore) {
    // Lazy so the branch-dependent text is composed only in dev; see
    // `devWarnLazy` for why an `if (DEV)` block would ship these literals.
    devWarnLazy(
      () =>
        `${where}: ${handedIn ? "a branch was given as an element rather than a function" : "a branch factory returned a node it had already returned"}, ` +
        "so the SAME node is being re-attached — any state it accumulated while detached (input value, scroll " +
        "position, classes set imperatively) comes back with it. Its reactive bindings are left intact rather than " +
        "disposed, because the node is not this directive's to tear down. Return a FRESH node per call " +
        "(`() => div(…)`) for rebuild semantics, or keep this form deliberately when the reuse is what you want.",
    );
  }

  let starts: Node[];
  if (node.nodeType === 11) {
    // A fragment: record its children before inserting it empties it. A bare
    // fragment re-attached later is already empty; put back what it held.
    if (node.firstChild) {
      starts = Array.from(node.childNodes);
      fragmentStarts.set(node, starts);
    } else {
      starts = fragmentStarts.get(node) ?? [];
    }
  } else {
    starts = [node];
  }
  const park = owned ? undefined : parked.get(node);
  // Read live wherever the starts are: a bare branch still leaving (or
  // attached anywhere else) brings what its range renders NOW — a nested
  // renderer may have removed and disposed what it rendered before. The
  // recorded list is only for starts that are detached, whose range can no
  // longer be read.
  const nodes = park?.firstChild
    ? Array.from(park.childNodes)
    : (!owned && starts.every((start) => start.parentNode === null) && detachedRanges.get(node)) ||
      attachedRanges(starts);
  // An empty fragment the directive built still has a lifetime: cleanup
  // registered on the fragment itself runs when the branch is released.
  if (nodes.length === 0 && !owned) return null;
  return {
    source: node,
    starts,
    nodes,
    owned,
    owner: null,
    phase: null,
    restore: null,
    unhold: null,
    waiting: false,
    released: false,
    inserting: false,
  };
}

/**
 * The nodes `starts` bring along on their first attachment: a start that is
 * already rendering its range somewhere else (an `each()` built in another
 * parent, a nested directive that has rendered) moves with that range, read
 * BEFORE the move — once the anchor has left, its old range is no longer its
 * sibling and cannot be found.
 */
function attachedRanges(starts: Node[]): Node[] {
  if (!starts.some(hasRange)) return starts;
  return [...new Set(starts.flatMap((start) => (start.parentNode === null ? [start] : collectRange([start]))))];
}

/**
 * Bring a branch's node list up to date before it is released, made inert,
 * animated, or searched for focus. Its starts render siblings after insertion
 * — rows of an `each()`, a nested `when` / `match` branch, what a `Fragment`
 * function child renders now — so the list recorded at insertion goes stale.
 * The range of every start is read again (DOM order, deduplicated); nodes a
 * renderer already removed (and disposed) are dropped.
 *
 * A start that renders a range is read again even when that range is empty
 * now (only the start itself): a nested directive that removed its content
 * no longer brings it. A start that is detached is left as recorded: its
 * range is no longer its sibling, and cannot be read.
 *
 * While an owned branch is being inserted, nothing is dropped: the list it is
 * inserted as is all its own, inserted or not yet (see `Branch.inserting`).
 */
function refreshNodes(branch: Branch): void {
  const starts = branch.starts;
  // The common case: one node that renders no sibling range.
  if (starts.length === 1 && (!hasRange(starts[0]) || starts[0].parentNode === null)) return;
  const live = collectRange(starts);
  branch.nodes = branch.owned && branch.inserting ? [...new Set([...branch.nodes, ...live])] : live;
  // A bare branch is re-attached from this list (see `resolveBranch`).
  if (!branch.owned) detachedRanges.set(branch.source, branch.nodes);
}

/**
 * Put a branch's nodes, in order, right after the anchor — while `live()`
 * holds. Inserting a node runs application code (a custom element's
 * `connectedCallback`), which may dispose the directive, switch it, or move
 * the anchor: liveness and the parent are read again before every insertion.
 *
 * @returns Whether every node was inserted.
 */
function insertBranch(anchor: Comment, nodes: Node[], live: () => boolean): boolean {
  let prev: Node = anchor;
  for (let i = 0; i < nodes.length; i++) {
    if (!live()) return false;
    const parent = anchor.parentNode;
    if (parent === null) return false;
    const node = nodes[i];
    // After the anchor when the previous node was moved away meanwhile.
    if (prev.parentNode !== parent) prev = anchor;
    // Already in place: an adopted branch the server rendered after the anchor.
    if (prev.nextSibling !== node) parent.insertBefore(node, prev.nextSibling);
    prev = node;
  }
  return live();
}

/**
 * Retire a branch: disposed when the directive BUILT it (a factory call or a
 * text node), detached either way. A bare element the caller handed in is
 * never disposed — its bindings belong to whoever created it. Shared by the
 * branch switch, the end of a leave, and the anchor teardown.
 *
 * Once only: a teardown that runs while a switch is retiring, leaving or
 * inserting the branch (application code disposed the directive) releases it,
 * and the switch's own release then does nothing.
 */
function releaseBranch(branch: Branch): void {
  if (branch.released) return;
  branch.released = true;
  refreshNodes(branch);
  if (branch.phase !== null) {
    branch.phase.cancel();
    branch.phase = null;
  }
  if (branch.restore !== null) {
    branch.restore();
    branch.restore = null;
  }
  const nodes = branch.nodes;
  // A bare branch with a range is parked rather than dropped: see `parked`.
  let park: DocumentFragment | undefined;
  if (!branch.owned && (branch.source.nodeType === 11 || branch.starts.some(hasRange))) {
    park = parked.get(branch.source);
    if (park === undefined) parked.set(branch.source, (park = document.createDocumentFragment()));
  }
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (branch.owned) dispose(node);
    if (park !== undefined) park.appendChild(node);
    else node.parentNode?.removeChild(node);
  }
  // An owned fragment is a lifetime of its own: cleanup registered on the
  // fragment object (`onCleanup(fn, fragment)`) runs after its nodes', once.
  // The fragment is empty by now, so this reaches only its own registrations.
  if (branch.owned && branch.source.nodeType === 11) dispose(branch.source);
  // An owned branch ENDS here: its owner is disposed, and work waiting on it
  // learns it will never resume. A branch the caller holds (a bare element
  // re-attached after a reclaim) lives on, so its owner only resumes.
  if (branch.owner !== null) {
    if (branch.owned) branch.owner.stop();
    else branch.owner.thaw?.();
    branch.owner = null;
  }
  // Released only now: an owned branch's bindings were disposed above, so
  // the ones the hold skipped are dropped rather than woken.
  if (branch.unhold !== null) {
    branch.unhold();
    branch.unhold = null;
  }
}

/**
 * Make a leaving branch non-interactive: `inert` and `aria-hidden="true"` on
 * its elements. Focus inside it is released explicitly — a browser drops focus
 * from an element that turns inert, and doing it here makes every engine agree
 * before the focus policy decides where focus goes.
 *
 * A branch whose range can still grow while it leaves (an `each()` or a
 * directive at its top level that is not frozen, because the caller owns it)
 * is watched until the leave ends: an element added to its range is made
 * inert too, and handed to `onLate` — the running leave enrolls it.
 *
 * @returns A function restoring the attributes, and ending the watch.
 */
function makeInert(branch: Branch, onLate: (elements: Element[]) => void): () => void {
  const saved: [Element, string | null, string | null][] = [];
  const marked = new Set<Node>();
  const mark = (nodes: Node[]): void => {
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].nodeType !== 1 || marked.has(nodes[i])) continue;
      const el = nodes[i] as Element;
      marked.add(el);
      saved.push([el, el.getAttribute("inert"), el.getAttribute("aria-hidden")]);
      el.setAttribute("inert", "");
      el.setAttribute("aria-hidden", "true");
    }
  };
  const active = typeof document !== "undefined" ? document.activeElement : null;
  mark(branch.nodes);
  const initial = saved.length;
  for (let i = 0; i < initial; i++) {
    const el = saved[i][0];
    if (active && (el === active || el.contains(active))) {
      (active as HTMLElement).blur?.();
      break;
    }
  }
  const unwatch = watchRange(branch, (late) => {
    const before = saved.length;
    mark(late);
    if (saved.length > before) onLate(saved.slice(before).map((entry) => entry[0]));
  });
  return () => {
    unwatch();
    for (let i = 0; i < saved.length; i++) {
      const [el, inert, hidden] = saved[i];
      if (inert === null) el.removeAttribute("inert");
      else el.setAttribute("inert", inert);
      if (hidden === null) el.removeAttribute("aria-hidden");
      else el.setAttribute("aria-hidden", hidden);
    }
  };
}

/**
 * Watch a branch whose range can still grow (an `each()` or a directive at its
 * top level): `onLate` receives the elements its range gained, once each.
 * Nothing to watch for a branch without such a range.
 *
 * @returns A function ending the watch.
 */
function watchRange(branch: Branch, onLate: (elements: Element[]) => void): () => void {
  const parent = branch.nodes[0]?.parentNode;
  if (!parent || typeof MutationObserver !== "function" || !branch.starts.some(hasRange)) return NOOP;
  const seen = new Set<Node>(branch.nodes);
  const observer = new MutationObserver(() => {
    refreshNodes(branch);
    const late: Element[] = [];
    for (const node of branch.nodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      if (node.nodeType === 1) late.push(node as Element);
    }
    if (late.length > 0) onLate(late);
  });
  observer.observe(parent, { childList: true });
  return () => observer.disconnect();
}

/**
 * The time an enter waits for content (`waitForContent`), fixed at the switch.
 * It ends when its own timer fires — not when a clock read says it is over —
 * so a wall clock moved back cannot strand the wait, and a timer delivered
 * early cannot leave it pending: the timer firing IS the end. Nothing extends
 * it: neither settling content, nor discoveries, nor nodes moving.
 */
interface ReadyWindow {
  expired: boolean;
  /** About how long is left (ms, monotonic clock), for the enter's own open window. */
  remaining(): number;
  /** Called once when it expires; the stage waiting on it sets it. */
  onExpire: (() => void) | null;
  /** Cancel the timer (and the callback): the wait is over, or dropped. */
  stop(): void;
}

function readyWindow(ms: number): ReadyWindow {
  const endAt = now() + ms;
  const win: ReadyWindow = {
    expired: false,
    remaining: () => (win.expired ? 0 : Math.max(0, Math.min(ms, endAt - now()))),
    onExpire: null,
    stop: () => {
      clearTimeout(timer);
      win.onExpire = null;
    },
  };
  const timer = setTimeout(() => {
    win.expired = true;
    const expire = win.onExpire;
    win.onExpire = null;
    expire?.();
  }, ms);
  return win;
}

/** A watch on where pending content can join or leave a branch; see {@link watchMembership}. */
interface Membership {
  /** Also watch the elements the branch's range gained since. */
  refresh(): void;
  stop(): void;
}

/**
 * While an enter waits for content, watch where a registered node can move
 * into or out of the entering branch: the branch's top-level range (its
 * parent, children only — a range adds and removes siblings there) and the
 * subtree of each of its elements. Branch-local: nothing above that parent,
 * no other subtree of it. `onChange` runs a microtask after a change
 * (coalesced), until `stop()`. Nothing to watch without `MutationObserver`.
 */
function watchMembership(branch: Branch, onChange: () => void): Membership | null {
  if (typeof MutationObserver !== "function") return null;
  const observer = new MutationObserver(onChange);
  const watched = new Set<Node>();
  const refresh = (): void => {
    const parent = branch.nodes[0]?.parentNode;
    if (parent && !watched.has(parent)) {
      watched.add(parent);
      observer.observe(parent, { childList: true });
    }
    for (const node of branch.nodes) {
      if (node.nodeType !== 1 || watched.has(node)) continue;
      watched.add(node);
      observer.observe(node, { childList: true, subtree: true });
    }
  };
  refresh();
  return {
    refresh,
    stop: () => {
      observer.disconnect();
      watched.clear();
    },
  };
}

/**
 * The shared body of `when` and `match`: render the branch `pick(value)` for
 * the current `read()` value after a comment anchor, and rebuild it whenever
 * that value changes (`Object.is`).
 */
function directive(
  name: string,
  read: () => unknown,
  pick: (value: unknown) => NodeChild,
  options: DirectiveOptions | undefined,
): Comment {
  const focusPolicy = options?.focus;
  // Transitions are a browser concern; a server render ignores them entirely.
  const tr = options?.transition !== undefined && !isServer() ? options.transition : undefined;
  const anchor = document.createComment(name);
  const scope = captureScope();
  // Deferred work (the first render, an `out-in` build) is skipped once the
  // subtree this directive was created in froze: see `captureFrozen`.
  const frozen = captureFrozen();
  let current: Branch | null = null;
  let last: unknown;

  let initialized = false;
  // Terminal. `dispose(anchor)` does not detach the anchor, so `parentNode`
  // cannot tell a disposed directive from a live one — without this flag the
  // queued initial render below would still run the branch factory and insert
  // DOM after teardown, outside the disposal traversal that already completed.
  let disposed = false;
  // Tracks whether a bare-element branch has already been attached once, so the
  // reuse warning fires on genuine reuse rather than on first render.
  const attachedOnce = new WeakSet<Node>();

  // Transitions only: branches playing their leave, oldest first, and an
  // `out-in` build waiting for them to finish.
  const leaving: Branch[] = [];
  let deferred = false;
  let deferredFocus: FocusSnapshot | null = null;
  // An `out-in` build waiting for a paused ancestor to resume; dropped on disposal.
  let dropDeferredWait = NOOP;

  /**
   * Build `branch` and insert it after the anchor. The build runs under its
   * own structural owner — the branch's lifecycle, whatever the animation
   * settings (and on the server) — so ending that owner at the switch ends
   * exactly this branch's work, `lifecycleScope()` registrations included,
   * and with a transition freezing it stops exactly this branch's bindings
   * and effects. A branch the directive does not own (a bare node, an empty
   * result) gives the owner back at once.
   *
   * The branch becomes `current` — with its lifecycle — as soon as the factory
   * has returned, BEFORE anything else runs application code: taking back a
   * leaving branch resumes its effects, and inserting a node runs a custom
   * element's `connectedCallback`. A teardown from any of them reaches the
   * whole branch, inserted or not yet, and the insertion stops there. The
   * caller has set `current` to `null`; the result is `current` again, or
   * `null` when nothing was built or it was released meanwhile.
   */
  const build = (branch: NodeChild): Branch | null => {
    const owner = structuralBinding(NOOP, anchor);
    // Untracked, like `each()` rows: the factory's own reads belong to the
    // bindings it creates, not to this directive. Tracked, every eager read in
    // the branch body became a dependency of the condition binding, so an
    // unrelated signal change re-ran the condition for nothing.
    const inBranch = <T>(fn: () => T): T => owner.run(() => untracked(() => inScope(scope, fn)));
    let built: Branch | null;
    try {
      built = inBranch(() => resolveBranch(branch, attachedOnce, name));
    } catch (err) {
      owner.stop();
      throw err;
    }
    if (built === null) {
      owner.stop();
      return null;
    }
    // A bare branch owns nothing: the owner is given back once it is in
    // place (a reclaimed one keeps its own, below).
    const ownsOwner = built.owned;
    if (ownsOwner) built.owner = owner;
    // The factory is application code: it may have disposed the directive,
    // or switched it (a newer branch is current).
    if (disposed || current !== null) {
      releaseBranch(built);
      if (!ownsOwner) owner.stop();
      return null;
    }
    let reclaimed: Branch | null = null;
    if (tr) {
      // Back to a branch that is still leaving (a bare element or fragment
      // re-attached): cancel its leave and take it back as is.
      for (let i = 0; i < leaving.length; i++) {
        if (leaving[i].source !== built.source) continue;
        reclaimed = leaving.splice(i, 1)[0];
        // Taken back before it finished leaving: its owner RESUMES (it is
        // not ended), so what it skipped re-runs and work waiting on it
        // continues. It keeps owning the subtree, and freezes again if the
        // branch leaves again.
        built.owner = reclaimed.owner;
        reclaimed.owner = null;
        break;
      }
    }
    // Published: from here on the directive's teardown releases it.
    current = built;
    built.inserting = true;
    let complete = false;
    try {
      if (reclaimed !== null) {
        const prev = reclaimed;
        if (prev.phase !== null) prev.phase.cancel();
        prev.phase = null;
        if (prev.restore !== null) prev.restore();
        prev.restore = null;
        const unhold = prev.unhold;
        prev.unhold = null;
        // Resuming runs what the owner skipped: application code.
        built.owner?.thaw?.();
        unhold?.();
        // Its range as it is NOW, read synchronously: a nested directive that
        // stayed live while the branch left may have removed (and disposed)
        // what it rendered, in this very task, before any observer ran.
        if (!built.released) refreshNodes(built);
      }
      const live = (): boolean => !disposed && current === built && !(built as Branch).released;
      complete = live() && inBranch(() => insertBranch(anchor, (built as Branch).nodes, live));
    } catch (err) {
      built.inserting = false;
      if (current === built) current = null;
      releaseBranch(built);
      if (!ownsOwner) owner.stop();
      throw err;
    }
    built.inserting = false;
    // A renderer in the branch that was waiting to be attached renders now.
    if (complete) inBranch(() => resumePending((built as Branch).nodes));
    if (!ownsOwner) owner.stop();
    return current === built && !built.released ? built : null;
  };

  /**
   * Run a phase on `branch`. A placeholder is installed first: the phase's
   * own callback is application code, and may dispose the directive, take the
   * branch back or switch again — any of which cancels the branch's phase.
   * A phase that comes back after that is cancelled at once (its timers
   * cleared) and never installed on a branch that was released.
   */
  const installPhase = (branch: Branch, start: () => PhaseRun | null): PhaseRun | null => {
    const placeholder: PhaseRun = { cancel: NOOP };
    branch.phase = placeholder;
    const run = start();
    if (branch.phase !== placeholder || branch.released || disposed) {
      run?.cancel();
      return null;
    }
    branch.phase = run;
    return run;
  };

  /** Play the leave of a branch already marked as leaving. */
  const startLeave = (branch: Branch): void => {
    branch.waiting = false;
    if (branch.released || disposed) return;
    const t = tr as DirectiveTransition;
    installPhase(branch, () =>
      runPhase(branch.nodes, t.leaveClass, t.leave, t.maxDuration, () => finishLeave(branch), `${name}(leave)`),
    );
  };

  /** Start every `in-out` leave that was waiting for an enter. */
  const startWaitingLeaves = (): void => {
    // A copy: a leave that ends at once leaves the list.
    for (const branch of [...leaving]) {
      if (disposed) return;
      if (branch.waiting) startLeave(branch);
    }
  };

  /** The outgoing branch at a switch: freeze it, make it inert, let it leave. */
  const beginLeave = (branch: Branch): void => {
    if (branch.released) return;
    const t = tr as DirectiveTransition;
    if (branch.phase !== null) {
      branch.phase.cancel();
      branch.phase = null;
    }
    refreshNodes(branch);
    if (branch.owner !== null) {
      branch.owner.freeze?.();
      // Its DOM is held too: a binding in it that its owner does not reach —
      // one an async continuation created after the build — is paused all
      // the same (see `holdSubtree`).
      branch.unhold = holdSubtree({
        contains: (node) => branch.nodes.some((n) => n === node || n.contains(node as Node)),
      });
    }
    // Late elements join the running class-based leave; an `in-out` branch
    // still waiting has none yet, and starts it over its refreshed range.
    const restore = makeInert(branch, (late) => branch.phase?.add?.(late));
    // Releasing focus from it ran application code (`blur` / `focusout`),
    // which may have disposed the directive: the teardown released the
    // branch then, without these attributes, which are undone here.
    if (branch.released) {
      restore();
      return;
    }
    branch.restore = restore;
    if (t.mode === "in-out") {
      // An older branch still waiting for the enter this switch interrupted
      // has nothing left to wait for.
      startWaitingLeaves();
      branch.waiting = true;
      leaving.push(branch);
      return;
    }
    leaving.push(branch);
    startLeave(branch);
  };

  /** A leave ended: remove and dispose the branch, then run a waiting `out-in` build. */
  const finishLeave = (branch: Branch): void => {
    branch.phase = null;
    const index = leaving.indexOf(branch);
    if (index !== -1) leaving.splice(index, 1);
    releaseBranch(branch);
    if (deferred && leaving.length === 0 && !disposed) buildDeferred();
  };

  /** Enter the branch just inserted, and sequence `in-out` leaves after it. */
  const afterInsert = (first: boolean): void => {
    if (disposed) return;
    const t = tr as DirectiveTransition;
    const entering = current;
    if (entering !== null && (!first || t.appear === true)) {
      enterWhenReady(entering);
      if (disposed) return;
      // Still entering (or waiting to): the waiting leaves start from its
      // completion, or from the switch that cancels it.
      if (entering.phase !== null) return;
    }
    if (t.mode === "in-out") startWaitingLeaves();
  };

  /**
   * Start `entering`'s enter once it can: after the first render of a nested
   * renderer in it (a top-level `each()` renders its rows a microtask later,
   * and they enter with the branch — bounded by `ENTER_WAIT_TURNS`), and while
   * this directive's ancestors are active. An ancestor that is paused (its
   * branch began a leave) defers the enter until it resumes — an enter that
   * never started is replayed then, once — and drops it if it ends. A switch,
   * a disposal or a reclaim cancels the wait through the placeholder phase.
   *
   * `waitForContent` starts its budget here, at the switch (see
   * `ReadyWindow`). A custom enter also waits for the pending content in the
   * branch (see `loadingWithin`), taken again from the branch each time a
   * registration begins or settles and each time a node moves into or out of
   * the branch, so content revealed by content is waited for too, and a
   * pending node removed from the branch no longer is; it starts when none is
   * left, or when the budget runs out. A class-based one does not wait, it
   * stays open for the content instead (see `startEnter`). A paused ancestor
   * defers either past the budget, until it resumes.
   */
  const enterWhenReady = (entering: Branch): void => {
    const t = tr as DirectiveTransition;
    const budget = typeof t.waitForContent === "number" && t.waitForContent > 0 ? t.waitForContent : 0;
    // Fixed now, at the switch; it ends when its own timer fires.
    const ready = budget > 0 ? readyWindow(Math.min(budget, HARD_CAP_MS)) : null;
    const contentReady = (): boolean =>
      t.enter === undefined ||
      ready === null ||
      ready.expired ||
      loadingWithin(entering.nodes, entering.owner).length === 0;
    if (!frozen() && !anyPending(entering.nodes) && contentReady()) {
      startEnter(entering, ready);
      return;
    }
    let cancelled = false;
    let waiting = false;
    let dropWait = NOOP;
    let dropLoaded = NOOP;
    let membership: Membership | null = null;
    let turns = 0;
    const stopWaiting = (): void => {
      dropWait();
      dropWait = NOOP;
      dropLoaded();
      dropLoaded = NOOP;
      membership?.stop();
      membership = null;
      if (ready !== null) ready.onExpire = null;
    };
    const placeholder: PhaseRun = {
      cancel: () => {
        cancelled = true;
        stopWaiting();
        ready?.stop();
      },
    };
    entering.phase = placeholder;
    const step = (): void => {
      if (cancelled || disposed || current !== entering || entering.phase !== placeholder) return;
      if (frozen()) {
        // Notified when the ancestors resume (or end), not polled. The
        // budget may run out meanwhile: the enter still waits for the
        // resume, and runs no user code before it.
        dropWait();
        dropWait = frozen.wait(step, NOOP);
        return;
      }
      refreshNodes(entering);
      if (anyPending(entering.nodes) && ++turns < ENTER_WAIT_TURNS) {
        queueMicrotask(step);
        return;
      }
      if (!contentReady()) {
        // Woken when some content settles (it may hold renderers of its own,
        // which get their turns), when a node moves into or out of the
        // branch, and when the budget runs out — whichever comes first.
        if (!waiting) {
          waiting = true;
          dropLoaded = onLoaded(() => {
            turns = 0;
            step();
          });
          membership = watchMembership(entering, step);
          (ready as ReadyWindow).onExpire = step;
        } else membership?.refresh();
        return;
      }
      stopWaiting();
      entering.phase = null;
      startEnter(entering, ready);
    };
    if (frozen()) step();
    else queueMicrotask(step);
  };

  /**
   * Play the enter of `entering`, then start any `in-out` leave it held back.
   *
   * A class-based enter takes in the elements the branch's range adds while it
   * runs (see `PhaseRun.add`). Until its `waitForContent` budget runs out it
   * also stays open for the pending content in the branch (see
   * `loadingWithin`): whenever a registration settles DONE inside the branch
   * (checked then), what it committed joins — a cancelled one enrolls
   * nothing — and the dependencies are taken again from the branch as it is
   * now, as they are whenever a node moves into or out of it. Content that
   * revealed a pending boundary or outlet of its own keeps the enter open for
   * that one too; one that left the branch is no longer waited for. The enter
   * closes once none is left, or when the budget runs out, which nothing
   * moves. Nothing joins once it has ended, or after that.
   */
  const startEnter = (entering: Branch, ready: ReadyWindow | null): void => {
    const t = tr as DirectiveTransition;
    const open = t.enter === undefined && ready !== null && !ready.expired ? ready.remaining() : 0;
    const waitingFor = open > 0 ? loadingWithin(entering.nodes, entering.owner) : [];
    // Nothing to stay open for: the budget is not needed any more.
    if (waitingFor.length === 0) ready?.stop();
    let stopWatching = NOOP;
    // A placeholder until the phase is running: the custom `enter` is
    // application code, and may dispose the directive or switch it, which
    // cancels the branch's phase — this one, before `runPhase` has returned.
    const placeholder: PhaseRun = { cancel: NOOP };
    entering.phase = placeholder;
    const run = runPhase(
      entering.nodes,
      t.enterClass,
      t.enter,
      t.maxDuration,
      () => {
        stopWatching();
        entering.phase = null;
        if (t.mode === "in-out" && !disposed) startWaitingLeaves();
      },
      `${name}(enter)`,
      waitingFor.length > 0 ? open : 0,
    );
    // Ended already (the completion ran), or invalidated while it started: a
    // phase that came back is cancelled — its timers with it — not installed.
    if (entering.phase !== placeholder || entering.released || disposed) {
      run?.cancel();
      ready?.stop();
      return;
    }
    const add = run?.add;
    if (run === null || add === undefined) {
      ready?.stop();
      entering.phase = run;
      return;
    }
    const unwatch = watchRange(entering, add);
    let dropLoaded = NOOP;
    let membership: Membership | null = null;
    const stopLoading = (): void => {
      dropLoaded();
      dropLoaded = NOOP;
      membership?.stop();
      membership = null;
      ready?.stop();
    };
    if (waitingFor.length > 0) {
      const win = ready as ReadyWindow;
      // Taken again from the branch as it is NOW, each time a registration
      // settles or a node moves into or out of the branch: containment is
      // checked before anything joins, so content that left the branch never
      // does, and a registration whose location joined the branch in the
      // same task it settled still does.
      const reconcile = (settled: readonly Pending[]): void => {
        if (win.expired || dropLoaded === NOOP) {
          stopLoading();
          return;
        }
        refreshNodes(entering);
        const inBranch = (el: Element): boolean => entering.nodes.some((n) => n === el || n.contains(el));
        for (const entry of settled) {
          if (entry.cancelled || !pendingWithin(entry, entering.nodes, entering.owner)) continue;
          const content = settledContent(entry).filter(inBranch);
          if (content.length > 0) add(content);
        }
        if (loadingWithin(entering.nodes, entering.owner).length === 0) {
          stopLoading();
          run.close?.();
        } else membership?.refresh();
      };
      dropLoaded = onLoaded(reconcile);
      membership = watchMembership(entering, () => reconcile(settledSinceNotify()));
      // The phase's own open window closes it at the same time.
      win.onExpire = stopLoading;
    }
    stopWatching = () => {
      unwatch();
      stopLoading();
    };
    entering.phase = {
      cancel: () => {
        stopWatching();
        run.cancel();
      },
      add,
    };
  };

  // An `out-in` build, run once the last leave ended (from an event or a
  // timer), for whatever value is current by then. It carries the owner scope
  // the directive was created in, and runs as the branch's structural owner,
  // as every rebuild does.
  const buildDeferred = bindOwnerScope((): void => {
    if (disposed || !deferred) return;
    // Inside a paused ancestor the build waits for it to resume (and is
    // dropped if it ends); `deferred` stays set until then. Disposal drops
    // the wait.
    if (frozen()) {
      dropDeferredWait();
      dropDeferredWait = frozen.wait(() => {
        dropDeferredWait = NOOP;
        if (deferred && !disposed) buildDeferred();
      }, NOOP);
      return;
    }
    deferred = false;
    const focused = deferredFocus;
    deferredFocus = null;
    if (!anchor.parentNode || current !== null) return;
    let built: Branch | null;
    try {
      built = binding.run(() => build(pick(last)));
    } catch (err) {
      reportError(err, { phase: "render", name, node: anchor });
      return;
    }
    // The factory, the insertion and the focus restore run application
    // code: nothing more once the directive is disposed.
    if (disposed) return;
    restoreFocusWithin(focused, built !== null ? built.nodes : [], name, focusPolicy);
    if (disposed) return;
    afterInsert(false);
  });

  // Bumped by every switch: a switch that application code superseded (a
  // nested write switched the directive again) stops where it is.
  let generation = 0;

  const update = () => {
    if (disposed) return;
    // Always evaluate the value to register reactive dependencies.
    const value = read();

    if (!anchor.parentNode) return;

    // Skip DOM work if the value hasn't changed. Compared by identity, not
    // truthiness: a different truthy value (another record) is a different
    // branch instance and must rebuild.
    if (initialized && Object.is(value, last)) return;
    last = value;
    const first = !initialized;
    initialized = true;
    const gen = ++generation;
    // Whether application code run by this switch disposed the directive or
    // switched it again: either way, this switch does nothing more.
    const superseded = (): boolean => disposed || gen !== generation;

    // Snapshot focus before the outgoing branch is detached (or made inert) —
    // afterwards `document.activeElement` has already fallen back to <body>.
    if (current !== null) refreshNodes(current);
    const focused = current !== null ? captureFocusWithin(current.nodes) : null;

    // Retire the previous branch.
    //
    // Disposing is ownership-dependent. A FACTORY branch is rebuilt on the next
    // switch, so its old node is garbage and must be disposed or its bindings
    // leak. A BARE ELEMENT branch is the same node every time: the caller built
    // it, holds a reference to it, and gets it back on the next switch.
    // Disposing that node tore down every reactive binding on it, so the
    // element came back inert — its reactive class/style/text silently stopped
    // updating, with nothing logged. Detaching is enough; teardown belongs to
    // whoever created it.
    //
    // The outgoing branch stays `current` while it is retired — the teardown
    // must still find it if a cleanup or a `leave` disposes the directive —
    // and is a leaving branch (or released) by the time it stops being so.
    if (current !== null) {
      const outgoing = current;
      if (tr) beginLeave(outgoing);
      else releaseBranch(outgoing);
      if (current === outgoing) current = null;
      if (superseded()) return;
    }

    const branch = pick(value);

    if (tr?.mode === "out-in" && leaving.length > 0) {
      // Built once the outgoing branches have left — unless the target IS a
      // bare branch that is still leaving, which is simply taken back.
      let reclaim = false;
      for (let i = 0; i < leaving.length && !reclaim; i++) reclaim = leaving[i].source === branch;
      if (!reclaim) {
        deferred = true;
        deferredFocus ??= focused;
        return;
      }
    }
    deferred = false;

    build(branch);
    if (superseded()) return;
    restoreFocusWithin(focused, current !== null ? current.nodes : [], name, focusPolicy);
    if (tr && !superseded()) afterInsert(first);
  };

  // Tie the reactive subscription to the anchor's lifetime. When the anchor is
  // disposed the subscription, current branch node, and branch closures are
  // released instead of leaking. Owner-stamped with the anchor, as in `show`,
  // so a condition or branch factory that throws on a scheduled run reaches
  // the enclosing ErrorBoundary.
  //
  // Structural: the branch's own bindings are owned by this one, so a flush
  // that switches the branch runs this first and the outgoing branch is
  // disposed (or frozen) before any of its bindings can re-run against the new
  // state.
  const binding = structuralBinding(update, anchor);
  // This directive's range, for an enclosing branch that holds the anchor: it
  // ends with the last node of the branch furthest from the anchor — the oldest
  // one still leaving, otherwise the current one.
  registerRange(anchor, () => {
    for (let i = 0; i <= leaving.length; i++) {
      const branch = i < leaving.length ? leaving[i] : current;
      if (branch === null) break;
      const nodes = collectRange(branch.starts);
      if (nodes.length > 0) return nodes[nodes.length - 1];
    }
    return null;
  });
  registerDisposer(anchor, () => {
    disposed = true;
    deferred = false;
    deferredFocus = null;
    dropDeferredWait();
    dropDeferredWait = NOOP;
    binding.stop();
    // The branch is a SIBLING of the anchor, not a child, so no ancestor
    // `dispose()` walk and no removal of the anchor alone reaches it. The
    // anchor owns the range it renders into — as `each`, `KeepAlive`, `Portal`
    // and every router outlet already treat theirs — so its teardown releases
    // the branch, and any branch still playing its leave. Without this,
    // unmounting a `when()` root, or switching away from an outer `when()` /
    // `match()` whose branch was this one, left the branch on the page with its
    // bindings still live.
    if (current !== null) releaseBranch(current);
    current = null;
    const rest = leaving.splice(0);
    for (let i = 0; i < rest.length; i++) releaseBranch(rest[i]);
  });

  if (!initialized) {
    // The deferred first render builds the branch outside any reactive run, so
    // it carries the owner scope the directive was created in, and runs as the
    // branch's structural owner, as every later rebuild does.
    queueFirstRender(
      anchor,
      bindOwnerScope(() => {
        if (!disposed && !initialized && anchor.parentNode) binding.run(update);
      }),
      frozen,
    );
  }

  return anchor;
}

/**
 * Conditional rendering directive. Renders content only when condition is true.
 * When false, renders nothing (comment placeholder). Re-evaluates reactively.
 *
 * Each branch may be a THUNK (rebuilt on every condition change) or a bare
 * element/value (attached as-is, and re-attached unchanged on every later
 * change). Both shapes are accepted so that `when` and {@link show} take the
 * same arguments; a bare element used to be accepted and then silently render
 * nothing, because the directive called it as a function only.
 *
 * A branch may be SEVERAL sibling nodes: return a `Fragment([...])` (or any
 * `DocumentFragment`). No wrapper element is needed, and on every switch all of
 * its nodes — including what its reactive children, an `each()` or a nested
 * `when` / `match` at its top level render now — are removed and disposed
 * together. Cleanup registered on the fragment itself runs then too.
 *
 * The branch is rebuilt whenever the condition's VALUE changes (`Object.is`),
 * not only when its truthiness flips, so
 * `when(() => selectedUser(), () => UserCard(selectedUser()!))` rebuilds the
 * card for each different user. To rebuild only when truthiness flips, return
 * a boolean: `when(() => !!x(), …)`. For rebuilds keyed on something other
 * than the value itself (an id, a mode), use {@link match}.
 *
 * @param condition Reactive getter; its value is compared to decide the branch
 * @param thenBranch Element, value, fragment, or function returning one, used when truthy
 * @param elseBranch Optional counterpart used when falsy. May be omitted in
 * favour of `options` (`when(cond, then, { focus: "discard" })`).
 * @param options Optional {@link DirectiveOptions}: focus policy and transitions
 * @returns A Comment anchor that manages the conditional content
 *
 * @example
 * ```ts
 * when(
 *   () => isLoggedIn(),
 *   () => div("Welcome!"),
 *   () => div("Please log in")
 * );
 * when(() => isLoggedIn(), div("Welcome!"));   // also valid
 *
 * // Two sibling buttons, no wrapper element:
 * when(() => confirming(), () => Fragment([button("Yes"), button("No")]));
 *
 * // Fade the outgoing branch out before it is removed:
 * when(() => ready(), () => Result(), () => Spinner(), {
 *   transition: { leaveClass: "fade-out" },
 * });
 * ```
 *
 * GOTCHA — branch factories rebuild only when `condition` changes. A branch
 * factory runs untracked, so a signal read *eagerly* inside it is captured once
 * and never updates:
 * ```ts
 * when(() => show(), () => div(`Count: ${count()}`));        // ✗ frozen at first count
 * when(() => show(), () => div(() => `Count: ${count()}`));  // ✓ reactive text child
 * ```
 * Drive per-branch reactivity with a nested getter (or a reactive child), not a
 * bare read in the factory body.
 *
 * TRAP — a rebuild DESTROYS the outgoing branch, so focus, selection and any
 * in-progress IME composition inside it are lost. The runtime restores focus
 * when the rebuilt branch contains an element with the same `id`, `name`, or
 * `data-focus-key`, and warns in dev when it cannot. For a subtree holding a
 * live edit, prefer {@link match} keyed on a shape key so the subtree is
 * rebuilt only when the shape genuinely changes. When dropping focus is the
 * point (Escape closes a panel), say so with `{ focus: "discard" }`, or route
 * it with `{ focus: { restoreTo: triggerEl } }`.
 *
 * A branch switch disposes the outgoing branch BEFORE any binding inside it can
 * re-run in the same flush, so a binding that is only valid while its branch is
 * mounted (`() => selected()!.name` under `when(() => selected(), …)`) never
 * observes the state that removed it. With a `transition`, the outgoing branch
 * is frozen at that same point instead, and disposed when its leave ends — see
 * {@link DirectiveOptions.transition}.
 */
export function when<T>(
  condition: () => T,
  thenBranch: NodeChild,
  elseBranch?: NodeChild | DirectiveOptions,
  options?: DirectiveOptions,
): Comment {
  requireDocument();
  if (isDirectiveOptions(elseBranch)) {
    options = elseBranch;
    elseBranch = undefined;
  }
  const elseNode = elseBranch as NodeChild | undefined;
  return directive(
    "when",
    condition,
    (show) => (show ? thenBranch : elseNode !== undefined ? elseNode : null),
    options,
  );
}

/**
 * Pattern matching directive. Renders content based on matching a reactive value
 * against multiple cases. Similar to a switch statement.
 *
 * @param value Reactive getter returning the value to match
 * @param cases Object mapping values to render functions
 * @param fallback Optional default case if no match found. May be omitted in
 * favour of `options`.
 * @param options Optional {@link DirectiveOptions} (`focus` policy and
 * `transition`, as in `when`)
 * @returns A Comment anchor that manages the matched content
 *
 * @example
 * ```ts
 * match(
 *   () => status(),
 *   {
 *     loading: () => Spinner(),
 *     error: () => ErrorMessage(),
 *     success: () => Content(),
 *   },
 *   () => div("Unknown status")
 * );
 * ```
 *
 * GOTCHA — like `when()`, a case factory rebuilds only when the matched key
 * changes. A signal read eagerly inside a case is frozen at build time; use a
 * nested getter (`() => div(() => label())`) for reactive per-case content.
 *
 * THIS IS THE KEYING PATTERN for subtrees that hold a live edit. Because the
 * subtree is rebuilt only when the KEY changes — not on every read of every
 * signal inside it — a form can update its contents through reactive attributes
 * and text children while its inputs keep focus, selection and IME state:
 *
 * ```ts
 * // Rebuilds only when the form's shape changes, not on every keystroke.
 * match(
 *   () => `${entity()}:${mode()}`,
 *   { "user:edit": () => UserForm(), "user:view": () => UserCard() },
 * );
 * ```
 *
 * Cases and the fallback accept a bare element as well as a factory, matching
 * {@link when} and {@link show}. A bare element is re-attached rather than
 * rebuilt, so it keeps whatever state it accumulated. A case may return a
 * `Fragment([...])` to render several sibling nodes, and `transition` animates
 * case changes exactly as in `when`:
 *
 * ```ts
 * match(() => screen(), {
 *   attract: () => Attract(),
 *   draw: () => Fragment([Canvas(), Toolbar()]),
 *   done: () => Done(),
 * }, { transition: { enterClass: "screen-in", leaveClass: "screen-out", mode: "out-in" } });
 * ```
 */
export function match<T extends string | number>(
  value: () => T,
  cases: Record<string, NodeChild>,
  fallback?: NodeChild | DirectiveOptions,
  options?: DirectiveOptions,
): Comment {
  requireDocument();
  if (isDirectiveOptions(fallback)) {
    options = fallback;
    fallback = undefined;
  }
  const fallbackNode = fallback as NodeChild | undefined;
  return directive(
    "match",
    () => String(value()),
    // `Object.hasOwn` rather than `||` so a case whose value is legitimately
    // falsy (an empty string, 0) still wins over the fallback.
    (key) => (Object.hasOwn(cases, key as string) ? cases[key as string] : (fallbackNode ?? null)),
    options,
  );
}
