import { renderedNodes } from "../../reactivity/bindChildNode";
import { bindOwnerScope, reactiveBinding, structuralBinding, untracked } from "../../reactivity/track";
import type { StructuralBinding } from "../../reactivity/track-core";
import { devWarnLazy } from "../dev";
import { reportError } from "../errors";
import { isServer } from "../ssr-context";
import { captureScope, inScope } from "./adoptScope";
import { type DirectiveTransition, type PhaseRun, runPhase } from "./branchTransition";
import { dispose, registerDisposer } from "./dispose";
import { captureFocusWithin, type FocusPolicy, type FocusSnapshot, restoreFocusWithin } from "./focusPreservation";
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
   *   DOM, and is removed and disposed when that ends: on `animationend` /
   *   `transitionend` of its elements, when the custom `leave` promise
   *   settles, or at a timeout computed from its styles, capped by
   *   `maxDuration` and never more than 5 s. Zero durations (no animation, a
   *   reduced-motion stylesheet, `display: none`) remove it synchronously.
   *
   * Its `onUnmount` callbacks and `registerDisposer` teardowns run when it is
   * actually removed, so a component can keep a canvas or a
   * `requestAnimationFrame` loop running until it has faded out.
   *
   * Switching again while a branch is leaving does not interrupt it; several
   * branches may be leaving at once. Switching back to a bare element (or
   * fragment) branch that is still leaving cancels its leave and re-attaches
   * it. The first render plays no enter unless `appear: true`. Disposing the
   * directive removes leaving branches at once. Server renders ignore
   * transitions entirely.
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
 * released through them, not through the (by then empty) fragment.
 */
interface Branch {
  /** The node the branch resolved to: an element, a text node, or a fragment. */
  source: Node;
  /** The top-level nodes it inserted after the anchor. */
  nodes: Node[];
  /** Whether the directive produced it (and so disposes it). See `resolveBranch`. */
  owned: boolean;
  /** Transitions only: the structural owner its subscribers were created under. */
  owner: StructuralBinding | null;
  /** Transitions only: the enter or leave in progress. */
  phase: PhaseRun | null;
  /** Transitions only: undoes the `inert` / `aria-hidden` a leave applied. */
  restore: (() => void) | null;
  /** Transitions only (`in-out`): leaving, but waiting for the new branch's enter. */
  waiting: boolean;
}

// A fragment's child nodes, recorded when it was first inserted, so a bare
// fragment branch (one handed in rather than built) can be re-attached after
// its insertion emptied it.
const fragmentNodes = new WeakMap<Node, Node[]>();

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

  let nodes: Node[];
  if (node.nodeType === 11) {
    // A fragment: record its children before inserting it empties it. A bare
    // fragment re-attached later is already empty; put back what it held.
    if (node.firstChild) {
      nodes = Array.from(node.childNodes);
      fragmentNodes.set(node, nodes);
    } else {
      nodes = fragmentNodes.get(node) ?? [];
    }
    if (nodes.length === 0) return null;
  } else {
    nodes = [node];
  }
  return { source: node, nodes, owned, owner: null, phase: null, restore: null, waiting: false };
}

/**
 * Bring a FRAGMENT branch's node list up to date before it is released, made
 * inert, or searched for focus. A reactive child of the fragment
 * (`Fragment([() => …])`) renders after its placeholder comment, and every
 * re-render replaces those nodes in the live DOM, so the list recorded at
 * insertion goes stale: the nodes it rendered since are added, in DOM order,
 * and the ones it has already removed (and disposed) are dropped.
 */
function refreshNodes(branch: Branch): void {
  if (branch.source.nodeType !== 11) return;
  const out: Node[] = [];
  const seen = new Set<Node>();
  const nodes = branch.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.parentNode === null || seen.has(node)) continue;
    seen.add(node);
    out.push(node);
    const rendered = node.nodeType === 8 ? renderedNodes(node) : null;
    if (rendered === null) continue;
    for (let j = 0; j < rendered.length; j++) {
      const child = rendered[j];
      if (child.parentNode === null || seen.has(child)) continue;
      seen.add(child);
      out.push(child);
    }
  }
  branch.nodes = out;
  // A bare fragment is re-attached from this list (see `resolveBranch`).
  if (!branch.owned) fragmentNodes.set(branch.source, out);
}

/** Put a branch's nodes, in order, right after the anchor. */
function insertBranch(parent: Node, anchor: Comment, nodes: Node[]): void {
  let prev: Node = anchor;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    // Already in place: an adopted branch the server rendered after the anchor.
    if (prev.nextSibling !== node) parent.insertBefore(node, prev.nextSibling);
    prev = node;
  }
}

/**
 * Retire a branch: disposed when the directive BUILT it (a factory call or a
 * text node), detached either way. A bare element the caller handed in is
 * never disposed — its bindings belong to whoever created it. Shared by the
 * branch switch, the end of a leave, and the anchor teardown.
 */
function releaseBranch(branch: Branch): void {
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
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (branch.owned) dispose(node);
    node.parentNode?.removeChild(node);
  }
  if (branch.owner !== null) {
    branch.owner.stop();
    branch.owner = null;
  }
}

/**
 * Make a leaving branch non-interactive: `inert` and `aria-hidden="true"` on
 * its elements. Focus inside it is released explicitly — a browser drops focus
 * from an element that turns inert, and doing it here makes every engine agree
 * before the focus policy decides where focus goes.
 *
 * @returns A function restoring the attributes as they were.
 */
function makeInert(nodes: Node[]): () => void {
  const saved: [Element, string | null, string | null][] = [];
  const active = typeof document !== "undefined" ? document.activeElement : null;
  let holdsFocus = false;
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].nodeType !== 1) continue;
    const el = nodes[i] as Element;
    saved.push([el, el.getAttribute("inert"), el.getAttribute("aria-hidden")]);
    el.setAttribute("inert", "");
    el.setAttribute("aria-hidden", "true");
    if (active && (el === active || el.contains(active))) holdsFocus = true;
  }
  if (holdsFocus) (active as HTMLElement).blur?.();
  return () => {
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

  /**
   * Build `branch` and insert it after the anchor. With transitions, the build
   * runs under its own structural owner, so freezing that owner at the next
   * switch stops exactly this branch's bindings and effects.
   */
  const build = (parent: Node, branch: NodeChild): Branch | null => {
    const owner = tr ? structuralBinding(NOOP, anchor) : null;
    // Untracked, like `each()` rows: the factory's own reads belong to the
    // bindings it creates, not to this directive. Tracked, every eager read in
    // the branch body became a dependency of the condition binding, so an
    // unrelated signal change re-ran the condition for nothing.
    const attach = () =>
      untracked(() =>
        inScope(scope, () => {
          const built = resolveBranch(branch, attachedOnce, name);
          if (built === null) return null;
          if (tr) {
            // Back to a branch that is still leaving (a bare element or
            // fragment re-attached): cancel its leave and take it back as is.
            for (let i = 0; i < leaving.length; i++) {
              const prev = leaving[i];
              if (prev.source !== built.source) continue;
              leaving.splice(i, 1);
              if (prev.phase !== null) prev.phase.cancel();
              if (prev.restore !== null) prev.restore();
              // Lifts the freeze; the node is no longer this directive's to own.
              if (prev.owner !== null) prev.owner.stop();
              break;
            }
          }
          insertBranch(parent, anchor, built.nodes);
          return built;
        }),
      );
    let built: Branch | null;
    try {
      built = owner !== null ? owner.run(attach) : attach();
    } catch (err) {
      owner?.stop();
      throw err;
    }
    if (owner !== null) {
      if (built?.owned) built.owner = owner;
      else owner.stop();
    }
    return built;
  };

  /** Play the leave of a branch already marked as leaving. */
  const startLeave = (branch: Branch): void => {
    branch.waiting = false;
    const t = tr as DirectiveTransition;
    branch.phase = runPhase(
      branch.nodes,
      t.leaveClass,
      t.leave,
      t.maxDuration,
      () => finishLeave(branch),
      `${name}(leave)`,
    );
  };

  /** Start every `in-out` leave that was waiting for an enter. */
  const startWaitingLeaves = (): void => {
    for (let i = 0; i < leaving.length; i++) if (leaving[i].waiting) startLeave(leaving[i]);
  };

  /** The outgoing branch at a switch: freeze it, make it inert, let it leave. */
  const beginLeave = (branch: Branch): void => {
    const t = tr as DirectiveTransition;
    if (branch.phase !== null) {
      branch.phase.cancel();
      branch.phase = null;
    }
    refreshNodes(branch);
    branch.owner?.freeze?.();
    branch.restore = makeInert(branch.nodes);
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
    const t = tr as DirectiveTransition;
    const entering = current;
    if (entering !== null && (!first || t.appear === true)) {
      entering.phase = runPhase(
        entering.nodes,
        t.enterClass,
        t.enter,
        t.maxDuration,
        () => {
          entering.phase = null;
          if (t.mode === "in-out") startWaitingLeaves();
        },
        `${name}(enter)`,
      );
      // Still entering: the waiting leaves start from its completion.
      if (entering.phase !== null) return;
    }
    if (t.mode === "in-out") startWaitingLeaves();
  };

  // An `out-in` build, run once the last leave ended (from an event or a
  // timer), for whatever value is current by then. It carries the owner scope
  // the directive was created in, and runs as the branch's structural owner,
  // as every rebuild does.
  const buildDeferred = bindOwnerScope((): void => {
    deferred = false;
    const focused = deferredFocus;
    deferredFocus = null;
    const parent = anchor.parentNode;
    if (!parent) return;
    try {
      binding.run(() => {
        current = build(parent, pick(last));
      });
    } catch (err) {
      reportError(err, { phase: "render", name, node: anchor });
      return;
    }
    restoreFocusWithin(focused, current ? current.nodes : [], name, focusPolicy);
    afterInsert(false);
  });

  const update = () => {
    if (disposed) return;
    // Always evaluate the value to register reactive dependencies.
    const value = read();

    const parent = anchor.parentNode;
    if (!parent) return;

    // Skip DOM work if the value hasn't changed. Compared by identity, not
    // truthiness: a different truthy value (another record) is a different
    // branch instance and must rebuild.
    if (initialized && Object.is(value, last)) return;
    last = value;
    const first = !initialized;

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
    if (current !== null) {
      if (tr) beginLeave(current);
      else releaseBranch(current);
      current = null;
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
        initialized = true;
        return;
      }
    }
    deferred = false;

    current = build(parent, branch);
    restoreFocusWithin(focused, current !== null ? current.nodes : [], name, focusPolicy);
    if (tr) afterInsert(first);
    initialized = true;
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
  registerDisposer(anchor, () => {
    disposed = true;
    deferred = false;
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
    queueMicrotask(
      bindOwnerScope(() => {
        if (!disposed && !initialized && anchor.parentNode) binding.run(update);
      }),
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
 * its nodes — including whatever its reactive children rendered since — are
 * removed and disposed together.
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
