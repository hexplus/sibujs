/**
 * Structural sharing for the data layer.
 *
 * A refetch almost always produces a brand-new object graph, even when the
 * server sent back exactly what it sent last time. Committing that graph to a
 * signal notifies every subscriber — signals compare with `Object.is` — so a
 * background refresh that changed nothing still re-ran every binding reading
 * the data, and a `when(() => q.data(), …)` or a `() => q.data() && Form()`
 * child rebuilt its subtree and threw away whatever the user was typing.
 *
 * `replaceEqualDeep(prev, next)` reconciles the new graph against the old one:
 *
 * - deeply equal → returns `prev` itself, so the signal write is a no-op and
 *   nothing is notified;
 * - partially equal → returns a new container in which every unchanged
 *   subtree is the OLD reference, so an `each()` keyed by reference, a
 *   `derived` over one branch, or an `equals`-less signal holding a sub-object
 *   stays stable while only the changed path gets fresh identities.
 *
 * Only plain objects (prototype `Object.prototype` or `null`) and arrays are
 * reconciled. Everything else — Date, Map, Set, class instances — is opaque
 * and compared by identity: its enumerable keys say nothing about its state,
 * and rebuilding it as a plain object would change its type.
 *
 * Internal to the data layer; not re-exported from `data.ts`.
 */

/**
 * The public knob shared by `query()` and `resource()`.
 *
 * - `true` (default) — reconcile with {@link replaceEqualDeep}.
 * - `false` — commit every result as-is (a fresh reference notifies).
 * - a function — custom reconciliation. It receives the previously committed
 *   value and the new one and returns what to commit; returning `prev` means
 *   "unchanged" and notifies nobody.
 */
export type StructuralSharingOption<T> = boolean | ((prev: T, next: T) => T);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isPlainArray(value: unknown): value is unknown[] {
  // `Array.isArray` alone admits subclasses; those carry behaviour that a
  // rebuilt plain array would silently drop.
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
}

/**
 * Recursion state for one reconciliation.
 *
 * `path` maps every `next` container on the current recursion path to its
 * depth. Data with back-references (`{ children: [{ parent: root }] }`) used to
 * recurse until the stack overflowed, on every single commit. Reaching a
 * container that is already on the path is a cycle.
 *
 * `cycleTo` is the shallowest depth a cycle below the current frame points
 * back to. Every container from that depth down to the back-reference is part
 * of the cycle, and none of them may be rebuilt or swapped for an old one: a
 * copy would leave the back-reference pointing at the ORIGINAL object, and an
 * old reference would pair `prev`'s cycle with `next`'s. Those containers are
 * returned as `next` unchanged — the branch is treated as changed, never
 * shared.
 */
interface Walk {
  path: Map<object, number>;
  cycleTo: number;
}

function reconcile(prev: unknown, next: unknown, depth: number, walk: Walk, newRoot: boolean): unknown {
  if (Object.is(prev, next)) return prev;

  const arrays = isPlainArray(prev) && isPlainArray(next);
  if (!arrays && !(isPlainObject(prev) && isPlainObject(next))) return next;
  // `{}` vs `Object.create(null)`: equal keys, but returning `prev` would hand
  // back a different kind of object than the caller just produced.
  if (Object.getPrototypeOf(prev) !== Object.getPrototypeOf(next)) return next;

  const nextObject = next as object;
  const seenAt = walk.path.get(nextObject);
  if (seenAt !== undefined) {
    walk.cycleTo = Math.min(walk.cycleTo, seenAt);
    return next;
  }

  const prevRecord = prev as Record<string | number, unknown>;
  const nextRecord = next as Record<string | number, unknown>;
  const nextKeys: Array<string | number> = arrays
    ? Array.from({ length: (next as unknown[]).length }, (_, i) => i)
    : Object.keys(nextRecord);
  const prevSize = arrays ? (prev as unknown[]).length : Object.keys(prevRecord).length;

  const copy: Record<string | number, unknown> = arrays
    ? (new Array(nextKeys.length) as unknown as Record<number, unknown>)
    : Object.create(Object.getPrototypeOf(next));

  // `allFromPrev`: every child resolved to the old reference → `prev` is equal.
  // `allFromNext`: no child was swapped for an old one → `next` already IS the
  // shared result, so return it rather than an identical copy (idempotency).
  let allFromPrev = prevSize === nextKeys.length;
  let allFromNext = true;

  const outerCycleTo = walk.cycleTo;
  walk.cycleTo = Number.POSITIVE_INFINITY;
  walk.path.set(nextObject, depth);
  for (const key of nextKeys) {
    // Array indices are iterated by length, so a hole is visited too. It must
    // stay a hole: a hole and an explicit `undefined` are different arrays
    // (`0 in a`, `Object.keys`, `map` and `forEach` all tell them apart), so
    // comparing by value made `[ <empty> ]` → `[undefined]` look unchanged and
    // the fetch notified nobody. The hole is not written into `copy`, which
    // was created with holes; writing `undefined` would turn it into a real
    // element.
    if (arrays && !Object.hasOwn(nextRecord, key)) {
      if (Object.hasOwn(prevRecord, key)) allFromPrev = false;
      continue;
    }
    const nextChild = nextRecord[key];
    // A key absent from `prev` has nothing to share with. `hasOwn` rather than
    // a value check so `{ a: undefined }` → `{ b: undefined }` is a change, and
    // a hole in `prev` → a real element in `next` is one too.
    const hasPrev = Object.hasOwn(prevRecord, key);
    const shared = hasPrev ? reconcile(prevRecord[key], nextChild, depth + 1, walk, false) : nextChild;
    // `"__proto__"` is DEFINED, never assigned. `copy` inherits from
    // `Object.prototype`, so `copy["__proto__"] = x` would invoke the inherited
    // setter and turn a JSON payload's OWN `"__proto__"` key into the rebuilt
    // object's prototype — `{"__proto__": {"isAdmin": true}}` from a server
    // response surfacing as an inherited `data.isAdmin === true`. It is the only
    // key with an inherited setter, so every other key keeps the cheap
    // assignment rather than paying for a descriptor on large payloads.
    if (key === "__proto__") {
      Object.defineProperty(copy, key, { value: shared, writable: true, enumerable: true, configurable: true });
    } else {
      copy[key] = shared;
    }
    if (!hasPrev || !Object.is(shared, prevRecord[key])) allFromPrev = false;
    if (!Object.is(shared, nextChild)) allFromNext = false;
  }
  walk.path.delete(nextObject);
  const reached = walk.cycleTo;
  // A cycle pointing at THIS container is closed here; one pointing higher is
  // still open and marks the ancestors in between.
  walk.cycleTo = Math.min(outerCycleTo, reached < depth ? reached : Number.POSITIVE_INFINITY);

  if (reached <= depth) return next;
  if (allFromPrev && !newRoot) return prev;
  if (allFromNext) return next;
  return copy;
}

/**
 * Return `prev` when `next` is deeply equal to it; otherwise return a value
 * equal to `next` that reuses every unchanged subtree of `prev`.
 *
 * Idempotent in its second argument: `replaceEqualDeep(prev, x)` where `x` is
 * itself a previous result returns `x` unchanged rather than a fresh copy.
 *
 * Cyclic data never throws: a container that is part of a cycle is returned as
 * `next` unshared (see {@link Walk}).
 */
export function replaceEqualDeep<T>(prev: unknown, next: T): T {
  return reconcile(prev, next, 0, { path: new Map(), cycleTo: Number.POSITIVE_INFINITY }, false) as T;
}

/**
 * Apply a {@link StructuralSharingOption}.
 *
 * `prev === undefined` means "nothing committed yet" — there is nothing to
 * share with, and a custom function is not asked to reconcile against a value
 * that never existed.
 *
 * `explicit` marks a value the caller WROTE (`setQueryData`, `resource.mutate`)
 * rather than one that was fetched. A fetched result is fully shared: deeply
 * equal means "nothing happened". An explicit write handing over a new
 * top-level reference is a statement that something changed — commonly an
 * in-place edit followed by `return { ...prev }`, where every child is still
 * `===` its old self and full sharing would hand back `prev` and drop the
 * write. So when `next !== prev`, the result is always a new top-level
 * reference: the default reconciliation still reuses every unchanged subtree
 * beneath it, and a custom function that answers `prev` is overridden with
 * `next`.
 */
export function applyStructuralSharing<T>(
  option: StructuralSharingOption<T>,
  prev: T | undefined,
  next: T,
  explicit = false,
): T {
  if (option === false || prev === undefined) return next;
  const forceNew = explicit && !Object.is(prev, next);
  if (typeof option === "function") {
    const shared = option(prev, next);
    return forceNew && Object.is(shared, prev) ? next : shared;
  }
  return reconcile(prev, next, 0, { path: new Map(), cycleTo: Number.POSITIVE_INFINITY }, forceNew) as T;
}
