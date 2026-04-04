import { track } from "../../reactivity/track";
import { devAssert, devWarn, isDev } from "../dev";
import { dispose } from "./dispose";
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
 * instead of plain values. This ensures the callback always reads fresh data
 * when a keyed item's data changes but its key stays the same, since the DOM
 * is reused without re-calling render.
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
  // Double-buffer maps: swap instead of allocate
  let nodeMap = new Map<string | number, Node>();
  let workMap = new Map<string | number, Node>();
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

  const keyFn = options.key;

  const update = () => {
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
      keyIndexMap.set(newKeys[i], i);
    }

    for (let i = 0; i < newLen; i++) {
      const key = newKeys[i];
      const existing = nodeMap.get(key);
      let node: Node;
      if (existing !== undefined) {
        node = existing;
      } else {
        // Create stable getters that close over the key and always read
        // from the latest array via keyIndexMap, making them reactive.
        const itemKey = key;
        const itemGetter = () => getArray()[keyIndexMap.get(itemKey)!];
        const indexGetter = () => keyIndexMap.get(itemKey)!;
        try {
          node = resolveNodeChild(render(itemGetter, indexGetter));
        } catch (err) {
          if (_isDev) {
            devWarn(
              `each: render threw for item at index ${i} (key="${newKeys[i]}"): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          node = document.createComment(`each:error:${i}`);
        }
      }
      workMap.set(key, node);
      newNodes[i] = node;
    }

    // --- Phase 2: Remove old nodes not present in new keys ---
    for (const [key, node] of nodeMap) {
      if (!workMap.has(key)) {
        dispose(node);
        if (node.parentNode) {
          parent.removeChild(node);
        }
      }
    }

    // --- Phase 3: LIS-based reordering ---
    if (newLen === 0) {
      oldLen = 0;
      const tmp = nodeMap;
      nodeMap = workMap;
      workMap = tmp;
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
  };

  // Track synchronously — dependencies are registered even if anchor
  // has no parent yet (getArray() runs before the parent check).
  track(update);

  // Fallback: if the anchor wasn't in the DOM during the initial track
  // (common when each() is called inside tagFactory nodes), schedule
  // a one-time retry so the initial items render before first paint.
  if (!initialized) {
    queueMicrotask(() => {
      if (!initialized && anchor.parentNode) {
        update();
      }
    });
  }

  return anchor;
}
