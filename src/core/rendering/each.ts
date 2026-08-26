import { batch } from "../../reactivity/batch";
import { track } from "../../reactivity/track";
import { devAssert, devWarn, isDev } from "../dev";
import { reportError } from "../errors";
import { signal } from "../signals/signal";
import { dispose, registerDisposer } from "./dispose";
import type { NodeChild } from "./types";

const _isDev = isDev();

/**
 * Resolves a NodeChild to a real Node.
 * - If it's a function, calls recursively.
 * - If it's already a Node, returns it.
 * - Otherwise (string/number), wraps in Text node.
 */
function resolveNodeChild(child: NodeChild): Node {
  if (typeof child === "function") {
    return resolveNodeChild((child as () => NodeChild)());
  }
  if (child instanceof Node) {
    return child;
  }
  return document.createTextNode(String(child));
}

/**
 * Computes the Longest Increasing Subsequence of an array of numbers,
 * returning the indices of elements that form the LIS.
 *
 * Uses the patience-sorting algorithm with binary search for O(n log n)
 * time complexity. This is used during reconciliation to identify the
 * largest set of nodes that are already in the correct relative order,
 * so only the remaining nodes need to be moved.
 *
 * @param arr An array of numbers (typically old-index positions).
 * @param len Number of elements to consider (allows reusing oversized arrays).
 * @returns An array of indices into `arr` that form the LIS.
 */
function longestIncreasingSubsequence(arr: number[], len: number): number[] {
  if (len === 0) return [];

  const tails: number[] = [];
  const predecessor: number[] = new Array(len);

  for (let i = 0; i < len; i++) {
    const val = arr[i];

    // Binary search for the leftmost tail value >= val
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[tails[mid]] < val) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    tails[lo] = i;
    predecessor[i] = lo > 0 ? tails[lo - 1] : -1;
  }

  // Reconstruct the LIS by walking back through predecessors
  const lisLength = tails.length;
  const result: number[] = new Array(lisLength);
  let k = tails[lisLength - 1];
  for (let i = lisLength - 1; i >= 0; i--) {
    result[i] = k;
    k = predecessor[k];
  }

  return result;
}

/**
 * One reconciled keyed row.
 *
 * The renderer runs once, when the key first appears. Reconciliation keeps the
 * row's DOM range and writes its cells instead, so descendants that read
 * `item()` / `index()` update through the normal reactive path.
 */
interface Row<T> {
  node: Node;
  item: () => T;
  setItem: (next: T) => void;
  index: () => number;
  setIndex: (next: number) => void;
}

/**
 * Renders a list of nodes efficiently with key-based diffing and
 * LIS-based move minimization.
 *
 * The reconciliation algorithm works as follows:
 * 1. Build or reuse nodes by key (create new, keep existing).
 * 2. Remove nodes whose keys no longer exist.
 * 3. For nodes that existed in both old and new lists, compute their
 *    old indices and find the Longest Increasing Subsequence (LIS).
 *    Nodes in the LIS are already in the correct relative order and
 *    do NOT need to be moved. Only nodes outside the LIS are moved.
 * 4. Walk the new key list in reverse and insert/position each node,
 *    skipping DOM operations for nodes that are part of the LIS.
 *
 * The render callback receives reactive getters `() => T` and `() => number`
 * instead of plain values. Each keyed row owns its own item and index cells,
 * written by reconciliation when the row is reused. `render` therefore runs
 * exactly ONCE per key — identity is preserved across updates — while anything
 * inside the row that reads `item()` or `index()` re-runs when reconciliation
 * assigns that row a new item or position.
 *
 * Identity is not value freshness: a row keeps its DOM node when its key is
 * unchanged, and still updates its contents when the item behind that key is
 * replaced.
 *
 * Reading `item()` subscribes to the ROW's cell, not to the whole-array signal,
 * so a row only re-renders when its own item/index actually changes — mutating
 * an unrelated row does not disturb it.
 *
 * @param getArray A reactive getter returning an array.
 * @param render A function that receives reactive item and index getters and returns a NodeChild.
 * @param options A key function for unique identity of items.
 * @returns A Comment node serving as the anchor for the list.
 */
export function each<T>(
  getArray: () => T[],
  render: (item: () => T, index: () => number) => NodeChild,
  options: { key: (item: T) => string | number },
): Comment {
  devAssert(typeof getArray === "function", "each: first argument must be a function that returns an array.");
  devAssert(typeof render === "function", "each: second argument must be a render function.");
  devAssert(
    options && typeof options.key === "function",
    "each: options.key must be a function that returns a unique key per item.",
  );

  const anchor = document.createComment("each:anchor");
  // Sentinel end marker — stable boundary reference, eliminates
  // the O(n) managed-nodes Set + sibling walk on every update.
  const end = document.createComment("each:end");

  // Double-buffered key arrays — swap instead of allocate
  const oldKeysBufA: (string | number)[] = [];
  const oldKeysBufB: (string | number)[] = [];
  let oldKeys = oldKeysBufA;
  let oldLen = 0;
  // Double-buffer maps: swap instead of allocate.
  //
  // A row is the unit of reuse: its DOM node plus the reactive cells that make
  // `item()` / `index()` fresh without re-running `render`.
  let nodeMap = new Map<string | number, Row<T>>();
  let workMap = new Map<string | number, Row<T>>();
  // Rows reused this pass, with the item/index they must now report. Applied in
  // ONE batch after reconciliation so row content updates observe the final DOM
  // order and cost a single drain rather than one per row.
  const pendingRows: Row<T>[] = [];
  const pendingItems: T[] = [];
  const pendingIndices: number[] = [];
  let pendingCount = 0;
  // Reusable arrays — grow as needed, never shrink
  let newNodes: Node[] = [];
  let newKeysBuf: (string | number)[] = [];
  let isStableBuf: Uint8Array = new Uint8Array(0);
  const oldKeyIndex = new Map<string | number, number>();
  let reusedNewBuf: number[] = [];
  let reusedOldBuf: number[] = [];
  // Per-key index tracking — maps key to its current index in the array,
  // so item/index getters always return fresh data without re-rendering.
  const keyIndexMap = new Map<string | number, number>();

  let initialized = false;
  let sentinelInserted = false;
  let rangeDisposed = false;

  const keyFn = options.key;

  const update = () => {
    // A queued notification must never revive a disposed range.
    if (rangeDisposed) return;
    // Always call getArray() first to register reactive dependencies,
    // even if anchor is not yet connected to the DOM.
    const arr = getArray();
    const newLen = arr.length;

    const parent = anchor.parentNode;
    if (!parent) return;

    // Insert sentinel once, right after anchor
    if (!sentinelInserted) {
      parent.insertBefore(end, anchor.nextSibling);
      sentinelInserted = true;
    }

    // Reuse key buffer — grow if needed
    if (newKeysBuf.length < newLen) {
      newKeysBuf = new Array(newLen);
    }
    for (let i = 0; i < newLen; i++) {
      newKeysBuf[i] = keyFn(arr[i]);
    }
    const newKeys = newKeysBuf;

    // Ensure node array is large enough
    if (newNodes.length < newLen) {
      newNodes = new Array(newLen);
    }

    workMap.clear();

    // --- Phase 1: Build or reuse nodes by key ---
    // Update key→index mapping so existing item/index getters read fresh data.
    keyIndexMap.clear();
    for (let i = 0; i < newLen; i++) {
      // Duplicate keys collapse to a single node reference, so two array
      // positions would share one DOM node — one row silently vanishes and
      // order can drift. Warn loudly in dev (mirrors bindChildNode).
      if (_isDev && keyIndexMap.has(newKeys[i])) {
        devWarn(
          `each: duplicate key "${String(newKeys[i])}" at index ${i} (first seen at ${keyIndexMap.get(newKeys[i])}). ` +
            "Keys must be unique — duplicates cause rows to be dropped or mis-ordered.",
        );
      }
      keyIndexMap.set(newKeys[i], i);
    }

    pendingCount = 0;
    for (let i = 0; i < newLen; i++) {
      const key = newKeys[i];
      const existing = nodeMap.get(key);
      let row: Row<T>;
      if (existing !== undefined) {
        // Same key → keep the DOM range and the renderer's output; refresh the
        // row's reactive cells instead. Queued rather than written now so every
        // row updates in one batch once the DOM is in its final order.
        row = existing;
        pendingRows[pendingCount] = row;
        pendingItems[pendingCount] = arr[i];
        pendingIndices[pendingCount] = i;
        pendingCount++;
      } else {
        // New key → row-local cells seeded with the current item/index, then
        // ONE render pass. Reading these subscribes to the row, not to the
        // whole-array signal, so unrelated row mutations never disturb it.
        const [itemGetter, setItem] = signal<T>(arr[i]);
        const [indexGetter, setIndex] = signal<number>(i);
        let node: Node;
        try {
          node = resolveNodeChild(render(itemGetter, indexGetter));
        } catch (err) {
          // The row is replaced by an inert placeholder so reconciliation can
          // continue; the failure itself goes through the CENTRAL pipeline.
          //
          // It previously dispatched the boundary event directly, which meant a
          // render failure in production with no ErrorBoundary mounted was
          // silent — exactly the second, parallel error system ../errors.ts
          // exists to remove.
          const key = newKeys[i];
          node = document.createComment(`each:error:${i}`);
          // Deferred by one microtask because the placeholder is not linked to
          // its parent yet, and boundary lookup walks the parentNode chain.
          // `reportError` retargets a Comment to its nearest Element ancestor,
          // so the anchor's parent no longer has to be resolved here.
          queueMicrotask(() => {
            reportError(err, {
              phase: "render",
              name: `each row (key="${String(key)}")`,
              node: anchor.parentNode ? anchor : undefined,
            });
          });
        }
        row = { node, item: itemGetter, setItem, index: indexGetter, setIndex };
      }
      workMap.set(key, row);
      newNodes[i] = row.node;
    }

    // --- Phase 2: Remove old rows not present in new keys ---
    for (const [key, row] of nodeMap) {
      if (!workMap.has(key)) {
        dispose(row.node);
        if (row.node.parentNode) {
          parent.removeChild(row.node);
        }
      }
    }

    // --- Phase 3: LIS-based reordering ---
    if (newLen === 0) {
      oldLen = 0;
      const tmp = nodeMap;
      nodeMap = workMap;
      workMap = tmp;
      initialized = true;
      // No rows remain, so there is nothing queued — but keep the buffer clean
      // rather than leaving a stale count for the next pass.
      pendingCount = 0;
      return;
    }

    // Build old key → index map (reuse closure-scoped map)
    oldKeyIndex.clear();
    for (let i = 0; i < oldLen; i++) {
      oldKeyIndex.set(oldKeys[i], i);
    }

    // Collect old positions of reused nodes for LIS computation.
    // Reuse closure-scoped buffers — grow if needed, track count.
    if (reusedNewBuf.length < newLen) {
      reusedNewBuf = new Array(newLen);
      reusedOldBuf = new Array(newLen);
    }
    let reusedCount = 0;
    for (let i = 0; i < newLen; i++) {
      const oldIdx = oldKeyIndex.get(newKeys[i]);
      if (oldIdx !== undefined) {
        reusedNewBuf[reusedCount] = i;
        reusedOldBuf[reusedCount] = oldIdx;
        reusedCount++;
      }
    }

    // Compute LIS over old positions (pass count to avoid sub-array)
    const lisIndices = longestIncreasingSubsequence(reusedOldBuf, reusedCount);

    // Reuse stable-index buffer — grow if needed, zero only the portion we use
    if (isStableBuf.length < newLen) {
      isStableBuf = new Uint8Array(newLen);
    } else {
      isStableBuf.fill(0, 0, newLen);
    }
    for (let i = 0; i < lisIndices.length; i++) {
      isStableBuf[reusedNewBuf[lisIndices[i]]] = 1;
    }

    // --- Phase 4: Position nodes in the DOM ---
    // Walk in reverse. Use sentinel `end` as boundary reference.
    // Skip no-op insertBefore when node is already in position.
    let nextRef: Node | null = end;

    for (let i = newLen - 1; i >= 0; i--) {
      const node = newNodes[i];

      if (isStableBuf[i]) {
        nextRef = node;
      } else {
        // Skip DOM operation if node is already in the correct position
        if (node.nextSibling !== nextRef) {
          parent.insertBefore(node, nextRef);
        }
        nextRef = node;
      }
    }

    // --- Phase 5: Update bookkeeping (double-buffer swap, no allocation) ---
    const nextOld = oldKeys === oldKeysBufA ? oldKeysBufB : oldKeysBufA;
    if (nextOld.length < newLen) nextOld.length = newLen;
    for (let i = 0; i < newLen; i++) nextOld[i] = newKeys[i];
    oldKeys = nextOld;
    oldLen = newLen;
    const tmp = nodeMap;
    nodeMap = workMap;
    workMap = tmp;
    initialized = true;

    flushRowCells();
  };

  /**
   * Publish the item/index each reused row must now report.
   *
   * Deferred to the end of reconciliation so row content re-renders against the
   * final DOM order, and batched so N reused rows cost ONE drain instead of N.
   * Cells use signal equality, so a row whose item and position are both
   * unchanged writes nothing and re-runs nothing — the common case for a list
   * update that only touched a few rows.
   */
  function flushRowCells(): void {
    if (pendingCount === 0) return;
    const count = pendingCount;
    pendingCount = 0;
    batch(() => {
      for (let i = 0; i < count; i++) {
        const row = pendingRows[i];
        row.setItem(pendingItems[i]);
        row.setIndex(pendingIndices[i]);
        // Drop the strong reference so a removed item is not retained by the
        // scratch buffer until the next reconciliation overwrites the slot.
        pendingRows[i] = undefined as unknown as Row<T>;
        pendingItems[i] = undefined as unknown as T;
      }
    });
  }

  // Track synchronously — dependencies are registered even if anchor
  // has no parent yet (getArray() runs before the parent check).
  // Capture teardown so disposing the anchor unsubscribes the effect.
  const untrack = track(update);

  /**
   * Tear down the whole logical range, not just the anchor.
   *
   * Rows and the `each:end` sentinel are *siblings* of the anchor, not its
   * children, so an ancestor `dispose()` walk never reaches them: unsubscribing
   * the effect alone would leave every row visible in the DOM and every row
   * binding alive. The anchor owns the range `(anchor, end]`, so its disposer
   * must dispose and remove each owned row plus the sentinel.
   *
   * Idempotent, and tolerant of rows a hostile parent already detached.
   */
  const disposeRange = () => {
    if (rangeDisposed) return;
    rangeDisposed = true;
    untrack();

    for (const row of nodeMap.values()) {
      dispose(row.node);
      row.node.parentNode?.removeChild(row.node);
    }

    if (end.parentNode) end.parentNode.removeChild(end);
    sentinelInserted = false;

    nodeMap.clear();
    workMap.clear();
    keyIndexMap.clear();
    oldKeyIndex.clear();
    oldLen = 0;
    // Release queued rows so a teardown mid-reconciliation cannot retain them.
    pendingRows.length = 0;
    pendingItems.length = 0;
    pendingIndices.length = 0;
    pendingCount = 0;
  };
  registerDisposer(anchor, disposeRange);

  // Fallback: if the anchor wasn't in the DOM during the initial track
  // (common when each() is called inside tagFactory nodes), schedule
  // a one-time retry so the initial items render before first paint.
  if (!initialized) {
    queueMicrotask(() => {
      if (!initialized && !rangeDisposed && anchor.parentNode) {
        update();
      }
    });
  }

  return anchor;
}
