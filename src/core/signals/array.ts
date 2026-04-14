import { enqueueBatchedSignal } from "../../reactivity/batch";
import type { ReactiveSignal } from "../../reactivity/signal";
import { notifySubscribers, recordDependency } from "../../reactivity/track";
import type { Accessor } from "./signal";
import { signal } from "./signal";

/**
 * Reactive array hook. Provides common array operations that
 * automatically trigger reactive updates.
 *
 * @param initial Initial array value
 * @returns Tuple [getter, actions]
 *
 * @example
 * ```ts
 * const [items, { push, remove, clear }] = array([1, 2, 3]);
 * push(4);          // [1, 2, 3, 4]
 * remove(1);        // [1, 3, 4]  (removes index 1)
 * clear();          // []
 * ```
 */
export interface ArrayActions<T> {
  /** Add one or more items to the end */
  push(...items: T[]): void;
  /** Remove and return the last item */
  pop(): T | undefined;
  /** Remove and return the first item */
  shift(): T | undefined;
  /** Add one or more items to the beginning */
  unshift(...items: T[]): void;
  /** Remove/replace elements at a position */
  splice(start: number, deleteCount?: number, ...items: T[]): T[];
  /** Remove item at index */
  remove(index: number): void;
  /** Remove first item matching predicate */
  removeWhere(predicate: (item: T) => boolean): void;
  /** Replace the entire array */
  set(items: T[]): void;
  /** Update item at a specific index */
  update(index: number, value: T): void;
  /** Update item at a specific index via updater function */
  updateWhere(predicate: (item: T) => boolean, updater: (item: T) => T): void;
  /** Sort the array in place */
  sort(compareFn?: (a: T, b: T) => number): void;
  /** Reverse the array in place */
  reverse(): void;
  /** Filter the array (returns new reactive array) */
  filter(predicate: (item: T, index: number) => boolean): void;
  /** Map and replace (transforms all items) */
  map(transform: (item: T, index: number) => T): void;
  /** Clear all items */
  clear(): void;
}

export function array<T>(initial: T[] = []): [Accessor<T[]>, ArrayActions<T>] {
  const [arr, setArr] = signal<T[]>([...initial]);

  const actions: ArrayActions<T> = {
    push(...items: T[]) {
      setArr((prev) => [...prev, ...items]);
    },

    pop() {
      let removed: T | undefined;
      setArr((prev) => {
        const copy = [...prev];
        removed = copy.pop();
        return copy;
      });
      return removed;
    },

    shift() {
      let removed: T | undefined;
      setArr((prev) => {
        const copy = [...prev];
        removed = copy.shift();
        return copy;
      });
      return removed;
    },

    unshift(...items: T[]) {
      setArr((prev) => [...items, ...prev]);
    },

    splice(start: number, deleteCount = 0, ...items: T[]) {
      let removed: T[] = [];
      setArr((prev) => {
        const copy = [...prev];
        removed = copy.splice(start, deleteCount, ...items);
        return copy;
      });
      return removed;
    },

    remove(index: number) {
      setArr((prev) => prev.filter((_, i) => i !== index));
    },

    removeWhere(predicate: (item: T) => boolean) {
      setArr((prev) => {
        const idx = prev.findIndex(predicate);
        if (idx === -1) return prev;
        return prev.filter((_, i) => i !== idx);
      });
    },

    set(items: T[]) {
      setArr([...items]);
    },

    update(index: number, value: T) {
      setArr((prev) => prev.map((item, i) => (i === index ? value : item)));
    },

    updateWhere(predicate: (item: T) => boolean, updater: (item: T) => T) {
      setArr((prev) => prev.map((item) => (predicate(item) ? updater(item) : item)));
    },

    sort(compareFn?: (a: T, b: T) => number) {
      setArr((prev) => [...prev].sort(compareFn));
    },

    reverse() {
      setArr((prev) => [...prev].reverse());
    },

    filter(predicate: (item: T, index: number) => boolean) {
      setArr((prev) => prev.filter(predicate));
    },

    map(transform: (item: T, index: number) => T) {
      setArr((prev) => prev.map(transform));
    },

    clear() {
      setArr([]);
    },
  };

  return [arr, actions];
}

/**
 * Optimized reactive array hook. Uses in-place mutations with a version
 * counter to avoid full array copies on every operation.
 *
 * Internally maintains a mutable array and only creates a frozen snapshot
 * when the getter is called after a mutation. Operations like push, pop,
 * splice, sort, and reverse mutate in-place (O(1) or O(n) as appropriate)
 * instead of copying the entire array.
 *
 * The public API is identical to `array`.
 *
 * @param initial Initial array value
 * @returns Tuple [getter, actions]
 *
 * @example
 * ```ts
 * const [items, { push, remove, clear }] = reactiveArray([1, 2, 3]);
 * push(4);          // [1, 2, 3, 4]  — mutates in-place, no copy
 * remove(1);        // [1, 3, 4]
 * clear();          // []
 * ```
 */
export function reactiveArray<T>(initial: T[] = []): [Accessor<readonly T[]>, ArrayActions<T>] {
  // Mutable internal storage — never exposed directly
  let data: T[] = [...initial];

  // Cached frozen snapshot; invalidated on mutation
  let snapshot: readonly T[] | null = null;

  // Dependency-tracking token (acts as a ReactiveSignal)
  const signal: ReactiveSignal = {};

  /**
   * Invalidate the cached snapshot and notify the reactivity system.
   * Called after every mutation.
   */
  function notify(): void {
    snapshot = null;
    if (!enqueueBatchedSignal(signal)) {
      notifySubscribers(signal);
    }
  }

  /**
   * Getter — registers a reactive dependency and returns a frozen snapshot.
   * Repeated reads between mutations return the same frozen reference.
   */
  function get(): readonly T[] {
    recordDependency(signal);
    if (snapshot === null) {
      const copy = data.slice();
      snapshot = Object.freeze(copy);
    }
    return snapshot;
  }

  const actions: ArrayActions<T> = {
    push(...items: T[]) {
      if (items.length === 0) return;
      data.push(...items);
      notify();
    },

    pop() {
      if (data.length === 0) return undefined;
      const removed = data.pop();
      notify();
      return removed;
    },

    shift() {
      if (data.length === 0) return undefined;
      const removed = data.shift();
      notify();
      return removed;
    },

    unshift(...items: T[]) {
      if (items.length === 0) return;
      data.unshift(...items);
      notify();
    },

    splice(start: number, deleteCount = 0, ...items: T[]) {
      const removed = data.splice(start, deleteCount, ...items);
      if (removed.length > 0 || items.length > 0) {
        notify();
      }
      return removed;
    },

    remove(index: number) {
      if (index < 0 || index >= data.length) return;
      data.splice(index, 1);
      notify();
    },

    removeWhere(predicate: (item: T) => boolean) {
      const idx = data.findIndex(predicate);
      if (idx === -1) return;
      data.splice(idx, 1);
      notify();
    },

    set(items: T[]) {
      data = [...items];
      notify();
    },

    update(index: number, value: T) {
      if (index < 0 || index >= data.length) return;
      if (Object.is(data[index], value)) return;
      data[index] = value;
      notify();
    },

    updateWhere(predicate: (item: T) => boolean, updater: (item: T) => T) {
      let changed = false;
      for (let i = 0; i < data.length; i++) {
        if (predicate(data[i])) {
          const updated = updater(data[i]);
          if (!Object.is(data[i], updated)) {
            data[i] = updated;
            changed = true;
          }
        }
      }
      if (changed) notify();
    },

    sort(compareFn?: (a: T, b: T) => number) {
      if (data.length <= 1) return;
      data.sort(compareFn);
      notify();
    },

    reverse() {
      if (data.length <= 1) return;
      data.reverse();
      notify();
    },

    filter(predicate: (item: T, index: number) => boolean) {
      const filtered = data.filter(predicate);
      if (filtered.length === data.length) return;
      data = filtered;
      notify();
    },

    map(transform: (item: T, index: number) => T) {
      let changed = false;
      for (let i = 0; i < data.length; i++) {
        const transformed = transform(data[i], i);
        if (!Object.is(data[i], transformed)) {
          data[i] = transformed;
          changed = true;
        }
      }
      if (changed) notify();
    },

    clear() {
      if (data.length === 0) return;
      data = [];
      notify();
    },
  };

  return [get, actions];
}
