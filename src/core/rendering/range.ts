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
