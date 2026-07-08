import { signal } from "./signal";

/**
 * Deep equality comparison for objects and arrays.
 * Falls back to Object.is for primitives.
 * Handles circular references, shared sub-references, and common
 * built-in types (Date, RegExp, Map, Set, ArrayBuffer, TypedArrays).
 *
 * The `seen` parameter tracks `(a, b)` pairs — not just `a` — so that
 * a shared sub-object compared against two different partners is always
 * fully checked, while genuine cycles (same a-with-same-b revisited)
 * still terminate.
 */
export function deepEqual(a: unknown, b: unknown, seen?: Map<object, Set<object>>): boolean {
  if (Object.is(a, b)) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;

  const objA = a as object;
  const objB = b as object;

  // Constructor mismatch → never equal (Date vs {}, Map vs Set, etc.)
  if (objA.constructor !== objB.constructor) return false;

  // Date
  if (a instanceof Date) return a.getTime() === (b as Date).getTime();

  // RegExp
  if (a instanceof RegExp) {
    const rb = b as RegExp;
    return a.source === rb.source && a.flags === rb.flags;
  }

  // Cycle / shared-ref detection — track (a, b) pairs, not just a.
  // Placed BEFORE Map/Set so self-referential containers don't infinite-recurse.
  if (!seen) seen = new Map();
  let peers = seen.get(objA);
  if (peers?.has(objB)) return true;
  if (!peers) {
    peers = new Set();
    seen.set(objA, peers);
  }
  peers.add(objB);

  // Map
  if (a instanceof Map) {
    const mb = b as Map<unknown, unknown>;
    if (a.size !== mb.size) return false;
    for (const [k, v] of a) {
      if (!mb.has(k)) return false;
      if (!deepEqual(v, mb.get(k), seen)) return false;
    }
    return true;
  }

  // Set (shallow membership — deep Set equality is O(n²) and rarely wanted)
  if (a instanceof Set) {
    const sb = b as Set<unknown>;
    if (a.size !== sb.size) return false;
    for (const item of a) {
      if (!sb.has(item)) return false;
    }
    return true;
  }

  // ArrayBuffer / TypedArray
  if (a instanceof ArrayBuffer) {
    const viewA = new Uint8Array(a);
    const viewB = new Uint8Array(b as ArrayBuffer);
    if (viewA.length !== viewB.length) return false;
    for (let i = 0; i < viewA.length; i++) {
      if (viewA[i] !== viewB[i]) return false;
    }
    return true;
  }
  // DataView is an ArrayBuffer view but has no `length` / indexed elements, so
  // it must be handled before the TypedArray branch — otherwise `length` is
  // undefined, the loop never runs, and any two DataViews compare equal.
  if (a instanceof DataView) {
    if (!(b instanceof DataView)) return false;
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
      if (a.getUint8(i) !== b.getUint8(i)) return false;
    }
    return true;
  }
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    const ta = a as unknown as { length: number; [i: number]: number };
    const tb = b as unknown as { length: number; [i: number]: number };
    if (ta.length !== tb.length) return false;
    for (let i = 0; i < ta.length; i++) {
      if (ta[i] !== tb[i]) return false;
    }
    return true;
  }

  // Array
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== (b as unknown[]).length) return false;
    return a.every((val, i) => deepEqual(val, (b as unknown[])[i], seen));
  }

  // Plain object
  const keysA = Object.keys(objA as Record<string, unknown>);
  const keysB = Object.keys(objB as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;

  // Equal length is not enough: the key SETS must match. Without the
  // `hasOwn` check, `{ a: undefined, b: 2 }` and `{ x: undefined, b: 2 }`
  // compare equal (the missing `a`/`x` both read as undefined) — a missed update.
  return keysA.every(
    (key) =>
      Object.hasOwn(objB as object, key) &&
      deepEqual((objA as Record<string, unknown>)[key], (objB as Record<string, unknown>)[key], seen),
  );
}

/**
 * Like signal but uses deep equality comparison instead of Object.is.
 * This prevents unnecessary re-renders when setting an object/array
 * to a structurally identical value.
 *
 * @param initial Initial value
 * @returns Tuple [getter, setter] — same shape as `signal()`, preserving
 *          the `Accessor<T>` brand on the getter.
 *
 * @example
 * ```ts
 * const [user, setUser] = deepSignal({ name: "Alice", age: 25 });
 * setUser({ name: "Alice", age: 25 }); // No notification — same structure
 * setUser({ name: "Bob", age: 25 });   // Notifies — different value
 * ```
 */
export function deepSignal<T>(initial: T) {
  return signal(initial, { equals: (a, b) => deepEqual(a, b) });
}
