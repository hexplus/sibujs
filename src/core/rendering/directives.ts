import { track } from "../../reactivity/track";
import { devWarnLazy } from "../dev";
import { dispose, registerDisposer } from "./dispose";
import { captureFocusWithin, restoreFocusWithin } from "./focusPreservation";
import type { NodeChild } from "./types";

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
  registerDisposer(resolved, track(update));
  return resolved;
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
 * @param condition Reactive getter; its value is compared to decide the branch
 * @param thenBranch Element, value, or function returning one, used when truthy
 * @param elseBranch Optional counterpart used when falsy
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
 * ```
 *
 * GOTCHA — branch factories rebuild only when `condition` changes. A signal
 * read *eagerly* inside a branch is captured once and never updates:
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
 * rebuilt only when the shape genuinely changes.
 */
/**
 * Resolve one branch of `when`/`match`, insert it after the anchor, and report
 * whether the calling directive OWNS the resulting node.
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
function attachBranch(
  parent: Node,
  anchor: Comment,
  branch: NodeChild,
  attachedOnce: WeakSet<Node>,
  where: string,
): { node: Node | null; owned: boolean } {
  // A function branch is a FACTORY and is invoked; anything else is already
  // the content. `NodeChild` includes `() => NodeChild`, so this one check
  // covers thunks, accessors, elements, strings and numbers alike.
  const result = typeof branch === "function" ? (branch as () => NodeChild)() : branch;
  if (result == null || typeof result === "boolean") return { node: null, owned: false };

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

  parent.insertBefore(node, anchor.nextSibling);
  return { node, owned };
}

export function when<T>(condition: () => T, thenBranch: NodeChild, elseBranch?: NodeChild): Comment {
  const anchor = document.createComment("when");
  let currentNode: Node | null = null;
  let lastCondition: T | undefined;

  let initialized = false;
  // Tracks whether a bare-element branch has already been attached once, so the
  // reuse warning fires on genuine reuse rather than on first render.
  const attachedOnce = new WeakSet<Node>();
  // Whether `currentNode` was produced BY this directive (a factory call, or a
  // text node built from a primitive) or merely handed to it. Only the former
  // may be disposed — see the teardown below.
  let currentNodeOwned = false;

  const update = () => {
    // Always evaluate condition to register reactive dependencies
    const show = condition();

    const parent = anchor.parentNode;
    if (!parent) return;

    // Skip DOM work if condition boolean hasn't changed
    if (initialized && show === lastCondition) return;
    lastCondition = show;

    // Snapshot focus before the outgoing branch is detached — afterwards
    // `document.activeElement` has already fallen back to <body>.
    const focused = currentNode ? captureFocusWithin([currentNode]) : null;

    // Remove previous node.
    //
    // Disposing is ownership-dependent. A FACTORY branch is rebuilt on the next
    // switch, so its old node is garbage and must be disposed or its bindings
    // leak. A BARE ELEMENT branch is the same node every time: the caller built
    // it, holds a reference to it, and gets it back on the next switch.
    // Disposing that node tore down every reactive binding on it, so the
    // element came back inert — its reactive class/style/text silently stopped
    // updating, with nothing logged. Detaching is enough; teardown belongs to
    // whoever created it.
    if (currentNode?.parentNode) {
      if (currentNodeOwned) dispose(currentNode);
      currentNode.parentNode.removeChild(currentNode);
      currentNode = null;
    }

    const branch = show ? thenBranch : elseBranch !== undefined ? elseBranch : null;
    const attached = attachBranch(parent, anchor, branch, attachedOnce, "when");
    currentNode = attached.node;
    currentNodeOwned = attached.owned;

    restoreFocusWithin(focused, currentNode ? [currentNode] : [], "when");
    initialized = true;
  };

  // Tie the reactive subscription to the anchor's lifetime. When the anchor is
  // disposed the condition subscription, current branch node, and branch
  // closures are released instead of leaking.
  registerDisposer(anchor, track(update));

  if (!initialized) {
    queueMicrotask(() => {
      if (!initialized && anchor.parentNode) update();
    });
  }

  return anchor;
}

/**
 * Pattern matching directive. Renders content based on matching a reactive value
 * against multiple cases. Similar to a switch statement.
 *
 * @param value Reactive getter returning the value to match
 * @param cases Object mapping values to render functions
 * @param fallback Optional default case if no match found
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
 * rebuilt, so it keeps whatever state it accumulated.
 */
export function match<T extends string | number>(
  value: () => T,
  cases: Record<string, NodeChild>,
  fallback?: NodeChild,
): Comment {
  const anchor = document.createComment("match");
  let currentNode: Node | null = null;
  let lastKey: string | undefined;

  let initialized = false;
  const attachedOnce = new WeakSet<Node>();
  // See `when`: only a node this directive produced may be disposed.
  let currentNodeOwned = false;

  const update = () => {
    // Always evaluate value() to register reactive dependencies
    const key = String(value());

    const parent = anchor.parentNode;
    if (!parent) return;

    // Skip DOM work if matched key hasn't changed
    if (initialized && key === lastKey) return;
    lastKey = key;

    // Same as `when`: the caret must be snapshotted while the outgoing case is
    // still attached. `match` is the pattern recommended for AVOIDING rebuilds,
    // but a genuine key change still replaces the subtree.
    const focused = currentNode ? captureFocusWithin([currentNode]) : null;

    if (currentNode?.parentNode) {
      if (currentNodeOwned) dispose(currentNode);
      currentNode.parentNode.removeChild(currentNode);
      currentNode = null;
    }

    // `Object.hasOwn` rather than `||` so a case whose value is legitimately
    // falsy (an empty string, 0) still wins over the fallback.
    const branch = Object.hasOwn(cases, key) ? cases[key] : fallback;
    const attached = attachBranch(parent, anchor, branch ?? null, attachedOnce, "match");
    currentNode = attached.node;
    currentNodeOwned = attached.owned;

    restoreFocusWithin(focused, currentNode ? [currentNode] : [], "match");
    initialized = true;
  };

  // Tie the reactive subscription to the anchor's lifetime so disposing the
  // anchor releases the value subscription and the matched branch.
  registerDisposer(anchor, track(update));

  if (!initialized) {
    queueMicrotask(() => {
      if (!initialized && anchor.parentNode) update();
    });
  }

  return anchor;
}
