import type { HeldCheck } from "../../reactivity/track";
import type { StructuralBinding } from "../../reactivity/track-core";
import { isServer } from "../ssr-context";

// ---------------------------------------------------------------------------
// Sibling ranges rendered after an anchor.
//
// `each()`, `when()` / `match()` and a `Fragment` function child render their
// content as SIBLINGS that follow a comment (the anchor or placeholder), and
// that content changes after the anchor was inserted. A directive that holds
// such an anchor as part of its own branch (a `Fragment([each(…)])` branch, an
// `each()` anchor returned as a branch) must treat the anchor and everything it
// currently renders as one unit when it makes the branch inert, animates it,
// removes it or re-attaches it.
//
// Each renderer registers how to find the LAST node of its range right now;
// `rangeEnd()` follows those links, since that last node may itself be the
// anchor of a nested range.
// ---------------------------------------------------------------------------

const ends = new WeakMap<Node, () => Node | null>();

/**
 * Declare that `start` renders a sibling range, and how to find its last node.
 * The getter returns `null` when the range is only `start` itself.
 *
 * @internal
 */
export function registerRange(start: Node, last: () => Node | null): void {
  ends.set(start, last);
}

// Anchors whose first render has not run yet: queued (`true`), or waiting for
// the anchor to be attached (the render itself). An enter waits for them, so
// the rows a top-level `each()` renders are part of what enters.
const pending = new WeakMap<Node, true | (() => void)>();

const NOTHING = (): void => {};

/**
 * Queue a renderer's first render (a renderer created where it had no parent
 * yet). It runs in a microtask when `anchor` is attached by then; otherwise it
 * waits until a directive inserts the anchor as (part of) a branch — see
 * {@link resumePending} — so an anchor built on its own and attached later
 * still renders. In a subtree that is paused (`held`: its branch is playing a
 * leave) the render waits for it to resume, and never runs if it ends.
 * `render` carries its own guards (disposed, already initialized).
 *
 * @internal
 */
export function queueFirstRender(anchor: Node, render: () => void, held?: HeldCheck): void {
  if (held) {
    const unguarded = render;
    render = () => {
      held.wait(unguarded, NOTHING);
    };
  }
  pending.set(anchor, true);
  queueMicrotask(() => {
    if (pending.get(anchor) !== true) return;
    if (anchor.parentNode === null) {
      pending.set(anchor, render);
      return;
    }
    pending.delete(anchor);
    render();
  });
}

/** Run the first render of every one of `nodes` that was waiting to be attached. @internal */
export function resumePending(nodes: readonly Node[]): void {
  for (const node of nodes) {
    const render = pending.get(node);
    if (typeof render !== "function") continue;
    pending.delete(node);
    render();
  }
}

/** Whether any of `nodes` still has its first render queued. @internal */
export function anyPending(nodes: readonly Node[]): boolean {
  for (const node of nodes) if (pending.has(node)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Pending content (readiness).
//
// Content that arrives later — a `Suspense` boundary's or a route outlet's
// initial content, or anything the application registers with
// `pendingContent()` — is PENDING until it has been committed (or deliberately
// settled). An enter that opted in with `DirectiveTransition.waitForContent`
// waits for the pending content inside the entering branch, within a bounded
// time, and lets it join when it is committed.
//
// Each registration is its own entry: several independent operations at the
// same location stay pending independently, and settling one never settles
// another. An entry is located at a node (inside the branch when the node
// is), or at a captured lifecycle (inside the branch when that lifecycle lies
// below the branch's). Entries are held until settled; every registration
// path settles them on disposal of what they are attached to.
//
// An entry settles in one of two ways, and an enter it takes part in tells
// them apart: DONE (its outcome is committed — content, an error view, a
// terminal empty result — and that content joins the enter) or CANCELLED
// (abandoned, superseded, or dropped with its location: nothing was committed
// for it, so nothing it renders now — a loading placeholder, say — joins).
// ---------------------------------------------------------------------------

/** One pending registration. @internal */
export interface Pending {
  /** Where it renders: a range anchor, an element, or `null` (a lifecycle). */
  readonly at: Node | null;
  /** The lifecycle it belongs to, when located by one. */
  readonly held: HeldCheck | null;
  /** Settled: done or cancelled. */
  settled: boolean;
  /** Settled by cancellation: nothing was committed for it. */
  cancelled: boolean;
  /** What was committed, when its settler named it (done only). */
  committed: Node[] | null;
}

/** How a registration settles. Idempotent together: the first call wins. @internal */
export interface Settle {
  /** Committed: what joins is `committed`, else what the location renders then. */
  done(committed?: Node[] | null): void;
  /** Abandoned, superseded or dropped: settles without content. */
  cancel(): void;
}

const registrations = new Set<Pending>();
const loadListeners = new Set<(settled: readonly Pending[]) => void>();
let notifyQueued = false;
// Entries settled since the last notification, delivered with it. Kept only
// while someone listens, and only until that delivery. An enter whose branch
// gained a registration's location in the same task the registration settled
// still gets the completion, though the entry has left `registrations`.
let settledBatch: Pending[] = [];

/** Tell the listeners, a microtask later (coalesced), that the registrations changed. */
function notifyLoad(settled: Pending | null): void {
  if (loadListeners.size === 0) return;
  if (settled !== null) settledBatch.push(settled);
  if (notifyQueued) return;
  notifyQueued = true;
  // A microtask later: a settler settles BEFORE or AFTER it inserts the
  // content, and either way the content is in place by then.
  queueMicrotask(() => {
    notifyQueued = false;
    const batch = settledBatch;
    settledBatch = [];
    for (const listener of [...loadListeners]) listener(batch);
  });
}

/**
 * Register pending content at `at` (a node) or `held` (a lifecycle). Returns
 * the entry and how it settles.
 *
 * @internal
 */
export function beginPending(at: Node | null, held: HeldCheck | null): Settle & { entry: Pending } {
  const entry: Pending = { at, held, settled: false, cancelled: false, committed: null };
  registrations.add(entry);
  notifyLoad(null);
  const settle = (cancelled: boolean, committed: Node[] | null): void => {
    if (entry.settled) return;
    entry.settled = true;
    entry.cancelled = cancelled;
    entry.committed = committed;
    registrations.delete(entry);
    notifyLoad(entry);
  };
  return {
    entry,
    done: (committed) => settle(false, committed ?? null),
    cancel: () => settle(true, null),
  };
}

const INERT: Settle = { done: NOTHING, cancel: NOTHING };

/**
 * Mark `anchor`'s initial content as pending (a `Suspense` boundary, a route
 * outlet, a `lazy()` container): `done` once that content is committed, or
 * the outcome that stands for it (an error view, a terminal empty result);
 * `cancel` on teardown, or when the outcome is dropped. Client only: a server
 * render plays no transition, and must not retain anything per request.
 *
 * @internal
 */
export function beginLoading(anchor: Node): Settle {
  if (isServer()) return INERT;
  const { done, cancel } = beginPending(anchor, null);
  return { done: () => done(), cancel };
}

/**
 * Whether `entry` lies inside a branch: at one of `nodes` or a descendant of
 * one, or at a lifecycle below `owner`. Read at the time of the call. @internal
 */
export function pendingWithin(entry: Pending, nodes: readonly Node[], owner: StructuralBinding | null): boolean {
  const at = entry.at;
  if (at !== null) {
    for (let i = 0; i < nodes.length; i++) if (nodes[i] === at || nodes[i].contains(at)) return true;
    return false;
  }
  return owner !== null && entry.held?.within(owner) === true;
}

/**
 * The pending registrations inside a branch (see {@link pendingWithin}).
 * Document order is not guaranteed. @internal
 */
export function loadingWithin(nodes: readonly Node[], owner: StructuralBinding | null): Pending[] {
  const found: Pending[] = [];
  if (registrations.size === 0) return found;
  for (const entry of registrations) if (pendingWithin(entry, nodes, owner)) found.push(entry);
  return found;
}

/**
 * What a settled registration committed, as elements: nothing when it was
 * cancelled; what its settler named; else what its location renders now —
 * the range after an anchor, the children of an element. @internal
 */
export function settledContent(entry: Pending): Element[] {
  if (!entry.settled || entry.cancelled) return [];
  let nodes: readonly Node[];
  if (entry.committed !== null) nodes = entry.committed;
  else if (entry.at === null) return [];
  else if (entry.at.nodeType === 1) nodes = Array.from(entry.at.childNodes);
  else nodes = collectRange([entry.at]);
  const out: Element[] = [];
  for (let i = 0; i < nodes.length; i++) if (nodes[i].nodeType === 1) out.push(nodes[i] as Element);
  return out;
}

/**
 * Call `listener` whenever pending content is registered or settles, with the
 * entries settled since the previous call. Returns the unsubscribe. @internal
 */
export function onLoaded(listener: (settled: readonly Pending[]) => void): () => void {
  loadListeners.add(listener);
  return () => {
    loadListeners.delete(listener);
  };
}

/** The entries settled since the last notification, not delivered yet. @internal */
export function settledSinceNotify(): readonly Pending[] {
  return settledBatch;
}

/** Number of unsettled registrations and readiness listeners, for leak tests. @internal */
export function pendingCount(): number {
  return registrations.size + loadListeners.size;
}

/** Whether `node` renders a sibling range whose content can change. @internal */
export function hasRange(node: Node): boolean {
  return ends.has(node);
}

/**
 * {@link registerRange} for a renderer that inserts a few nodes of its own
 * right after its anchor (a route outlet's page, loading and error views, a
 * `KeepAlive`'s cached case): the range ends at whichever of them, still
 * attached next to the anchor, comes last.
 *
 * @internal
 */
export function registerNodesRange(anchor: Node, nodes: () => (Node | null)[]): void {
  registerRange(anchor, () => {
    const parent = anchor.parentNode;
    const wanted = nodes().filter((n) => n !== null && n.parentNode === parent);
    let last: Node | null = null;
    let left = wanted.length;
    for (let n = anchor.nextSibling; n !== null && left > 0; n = n.nextSibling) {
      if (wanted.includes(n)) {
        last = n;
        left--;
      }
    }
    return last;
  });
}

/**
 * The last node of the range that starts at `node`, nested ranges included;
 * `node` itself when it starts none. Only following siblings of `node` are
 * accepted, so a stale or detached end can never widen the range elsewhere.
 *
 * @internal
 */
export function rangeEnd(node: Node): Node {
  let cur = node;
  for (let get = ends.get(cur); get !== undefined; get = ends.get(cur)) {
    const next = get();
    if (next === null || next === cur || next.parentNode !== node.parentNode) break;
    cur = next;
  }
  return cur;
}

/**
 * The nodes `starts` occupy now, in DOM order: each start that is still
 * attached followed by the range it renders. Detached starts are skipped (a
 * reactive child already removed and disposed them). A range whose end cannot
 * be reached from its start contributes only its start.
 *
 * @internal
 */
export function collectRange(starts: readonly Node[]): Node[] {
  const out: Node[] = [];
  const seen = new Set<Node>();
  for (const start of starts) {
    if (start.parentNode === null) continue;
    const end = rangeEnd(start);
    let node: Node | null = start;
    let span = [start];
    while (node !== end) {
      node = (node as Node).nextSibling;
      if (node === null) {
        span = [start];
        break;
      }
      span.push(node);
    }
    for (const n of span) {
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  return out;
}
