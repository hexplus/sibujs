import { devWarnLazy } from "../dev";

// ---------------------------------------------------------------------------
// Keeping the caret alive across a reactive rebuild.
//
// A reactive block that re-creates its children destroys the focused node. The
// browser then moves focus to <body>, and the user's next keystroke goes
// nowhere — one character typed into an input inside such a block ends the
// edit. Nothing throws and nothing is logged, so it reads as the application
// losing what you typed rather than as a framework behaviour.
//
// This module does the honest half of the fix: where the rebuilt subtree
// contains an element whose identity can be RE-ESTABLISHED, focus and the
// selection range come back; where it cannot, dev says so and names the way
// out. It deliberately does not guess. Focusing the wrong element is worse than
// focusing nothing, because the next keystroke then lands in a field the user
// was not editing.
//
// What identity means here, in priority order:
//   1. `data-focus-key` — an explicit author-supplied identity.
//   2. `id`
//   3. `name`
// All three are stable across a rebuild by construction, because the author
// writes them into the factory that rebuilds. Structural matching ("the second
// input in the third div") is deliberately NOT used: it silently re-targets the
// caret whenever the shape changes, which is exactly when a rebuild happens.
//
// A match must also be UNIQUE in the rebuilt subtree. `name` is shared by
// design — every radio in a group carries the same one — so taking the first
// hit would put the caret on a sibling control the user was not using. An
// ambiguous match is treated as no match, and warned about.
//
// Focus is restored only when it was LOST (it fell to <body>). If something in
// the rebuild moved focus deliberately, that wins: an autofocusing branch is
// not something to fight.
//
// NOT preserved, and it cannot be: an in-progress IME composition. The
// composition is owned by the DOM node, so destroying the node ends it. A
// keyed subtree that never rebuilds mid-edit is the only real fix, which is
// what the warning points at.
// ---------------------------------------------------------------------------

/** Identity attributes consulted, in priority order. */
const IDENTITY_ATTRS = ["data-focus-key", "id", "name"] as const;

/**
 * Input types whose selection range is readable/writable. Reading
 * `selectionStart` on any other type throws in some engines, so the set is an
 * allowlist rather than a try/catch.
 */
const SELECTABLE_TYPES = new Set(["text", "search", "url", "tel", "password", ""]);

export interface FocusSnapshot {
  /** The element that had focus, kept so we can tell whether it survived. */
  el: Element;
  /** `attr=value` identity pair, or null when the element has no stable identity. */
  attr: string | null;
  value: string | null;
  tag: string;
  start: number | null;
  end: number | null;
  direction: string | null;
}

function selectionOf(el: Element): Pick<FocusSnapshot, "start" | "end" | "direction"> {
  const tag = el.tagName;
  const selectable =
    tag === "TEXTAREA" || (tag === "INPUT" && SELECTABLE_TYPES.has((el as HTMLInputElement).type.toLowerCase()));
  if (!selectable) return { start: null, end: null, direction: null };
  const field = el as HTMLInputElement | HTMLTextAreaElement;
  return { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection };
}

/**
 * Snapshot the focused element if it lives inside `nodes`, which are about to
 * be removed. Returns null — the overwhelmingly common case — when nothing is
 * focused or focus is elsewhere on the page.
 *
 * @param nodes The nodes a rebuild is about to discard.
 * @returns A snapshot to pass to {@link restoreFocusWithin}, or null when there
 * is no focus at stake.
 */
export function captureFocusWithin(nodes: readonly Node[]): FocusSnapshot | null {
  if (nodes.length === 0 || typeof document === "undefined") return null;
  const active = document.activeElement;
  // `<body>` is the "nothing is focused" resting state. Bailing here keeps this
  // to one property read on every rebuild in a page where no field is active.
  if (!active || active === document.body) return null;

  let inside = false;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n === active || (n.nodeType === 1 && (n as Element).contains(active))) {
      inside = true;
      break;
    }
  }
  if (!inside) return null;

  let attr: string | null = null;
  let value: string | null = null;
  for (let i = 0; i < IDENTITY_ATTRS.length; i++) {
    const candidate = active.getAttribute(IDENTITY_ATTRS[i]);
    if (candidate) {
      attr = IDENTITY_ATTRS[i];
      value = candidate;
      break;
    }
  }

  return { el: active, attr, value, tag: active.tagName, ...selectionOf(active) };
}

/** Quote a value for use inside an attribute selector. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Find the ONE element matching `selector`, or nothing.
 *
 * Ambiguity is treated as failure, not as a reason to pick the first hit.
 * `name` in particular is shared by design — every radio in a group carries the
 * same one — so first-match would restore focus onto a sibling control and the
 * user's next keystroke would act on something they were not using. That is
 * strictly worse than losing focus, which is at least visible. When the match
 * is ambiguous the caller warns instead.
 */
function findUniqueByIdentity(nodes: readonly Node[], selector: string): { el: Element | null; count: number } {
  let el: Element | null = null;
  let count = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType !== 1) continue;
    const root = n as Element;
    if (root.matches(selector)) {
      count++;
      el ??= root;
    }
    const inner = root.querySelectorAll(selector);
    for (let j = 0; j < inner.length; j++) {
      count++;
      el ??= inner[j];
    }
    // Two is already ambiguous; counting the rest tells us nothing more.
    if (count > 1) return { el: null, count };
  }
  return count === 1 ? { el, count } : { el: null, count };
}

/** Give `el` focus and put the snapshotted selection range back. */
function refocus(el: Element, snapshot: FocusSnapshot): void {
  (el as HTMLElement).focus();
  if (snapshot.start !== null && typeof (el as HTMLInputElement).setSelectionRange === "function") {
    const field = el as HTMLInputElement;
    // The rebuilt value may be shorter than the old one; clamping keeps
    // setSelectionRange from throwing on an out-of-range index.
    const max = field.value.length;
    const start = Math.min(snapshot.start, max);
    const end = Math.min(snapshot.end ?? start, max);
    field.setSelectionRange(start, end, (snapshot.direction as "forward" | "backward" | "none") ?? "none");
  }
}

/**
 * Put focus (and the selection range) back after a rebuild, or explain in dev
 * why it could not be done.
 *
 * @param snapshot Result of {@link captureFocusWithin}, or null.
 * @param nodes The nodes the rebuild produced.
 * @param where Name of the calling directive, used in the dev warning.
 * @returns Nothing.
 */
export function restoreFocusWithin(snapshot: FocusSnapshot | null, nodes: readonly Node[], where: string): void {
  if (!snapshot) return;
  if (typeof document === "undefined") return;

  const active = document.activeElement;

  // Still focused — nothing happened worth undoing. Re-focusing here would only
  // risk an unwanted scroll.
  if (active === snapshot.el) return;

  // Focus is on some OTHER real element. Something during the rebuild moved it
  // deliberately (a branch that autofocuses its first field, say), and stealing
  // it back would fight the application. Only a focus that fell to the document
  // is a focus that was LOST.
  //
  // Testing where focus actually IS — rather than whether the old node is still
  // connected — is what catches the case where the node survives the rebuild
  // but is blurred by being MOVED: re-inserting a focused element blurs it in
  // real browsers, so `isConnected` reported "nothing to do" while the caret
  // was already gone.
  if (active && active !== document.body && active !== document.documentElement) return;

  // The node itself survived (reused or reordered) and merely lost focus. No
  // identity matching needed — this IS the element the user was editing.
  if (snapshot.el.isConnected) {
    refocus(snapshot.el, snapshot);
    return;
  }

  let ambiguous = false;
  if (snapshot.attr && snapshot.value) {
    const { el: replacement, count } = findUniqueByIdentity(nodes, `[${snapshot.attr}=${quote(snapshot.value)}]`);
    // Same identity AND same element type. A `data-focus-key` reused across a
    // <input> and a <button> is an authoring mistake, not an invitation to move
    // the caret onto a button.
    if (replacement && replacement.tagName === snapshot.tag) {
      refocus(replacement, snapshot);
      return;
    }
    // "Several matches" and "no match" need different advice, so the warning
    // below distinguishes them.
    ambiguous = count > 1;
  }

  // Composed inside the callback rather than in an `if (DEV)` block: a
  // published build leaves `DEV` as a runtime var, so a guarded block's string
  // literals are not provably dead and ship to production. See `devWarnLazy`.
  devWarnLazy(() => {
    const id = snapshot.attr ? ` (${snapshot.attr}="${snapshot.value}")` : "";
    const why = ambiguous
      ? `several elements in the rebuilt subtree share ${snapshot.attr}="${snapshot.value}", so there is no way to ` +
        "tell which one the user was in — a shared name (a radio group) identifies a GROUP, not a control. Add a " +
        "unique id or data-focus-key to each"
      : "no element in the rebuilt subtree carries the same identity. Give it a stable id, name, or data-focus-key " +
        "that the rebuild reproduces";
    return (
      `${where}: a reactive rebuild discarded the focused element <${snapshot.tag.toLowerCase()}>${id} and could not ` +
      "re-establish it, so focus fell back to <body>. An in-progress edit ends here, and an in-progress IME " +
      "composition is lost outright — a composition belongs to the DOM node, so it cannot survive the node being " +
      `destroyed. ${why}, or stop the rebuild from happening: key the subtree with match(() => shapeKey(), { … }) ` +
      "so it is re-created only when the shape actually changes, and drive the rest with reactive attributes and " +
      "text children, which mutate nodes in place instead of replacing them."
    );
  });
}
