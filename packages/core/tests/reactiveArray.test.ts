import { describe, expect, it, vi } from "vitest";
import { reactiveArray } from "../src/core/signals/array";
import { track } from "../src/reactivity/track";

describe("reactiveArray", () => {
  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------
  describe("initialization", () => {
    it("should initialize with an empty array by default", () => {
      const [items] = reactiveArray<number>();
      expect(items()).toEqual([]);
    });

    it("should initialize with the provided array", () => {
      const [items] = reactiveArray([1, 2, 3]);
      expect(items()).toEqual([1, 2, 3]);
    });

    it("should not share state with the initial array", () => {
      const initial = [1, 2, 3];
      const [items] = reactiveArray(initial);
      initial.push(4);
      expect(items()).toEqual([1, 2, 3]);
    });
  });

  // ---------------------------------------------------------------------------
  // push / pop / shift / unshift
  // ---------------------------------------------------------------------------
  describe("push / pop / shift / unshift", () => {
    it("should push items", () => {
      const [items, { push }] = reactiveArray<number>([1]);
      push(2, 3);
      expect(items()).toEqual([1, 2, 3]);
    });

    it("should push a single item", () => {
      const [items, { push }] = reactiveArray<number>([]);
      push(42);
      expect(items()).toEqual([42]);
    });

    it("should pop the last item", () => {
      const [items, { pop }] = reactiveArray([1, 2, 3]);
      const removed = pop();
      expect(removed).toBe(3);
      expect(items()).toEqual([1, 2]);
    });

    it("should return undefined when popping an empty array", () => {
      const [items, { pop }] = reactiveArray<number>([]);
      const removed = pop();
      expect(removed).toBeUndefined();
      expect(items()).toEqual([]);
    });

    it("should shift the first item", () => {
      const [items, { shift }] = reactiveArray([1, 2, 3]);
      const removed = shift();
      expect(removed).toBe(1);
      expect(items()).toEqual([2, 3]);
    });

    it("should return undefined when shifting an empty array", () => {
      const [items, { shift }] = reactiveArray<number>([]);
      const removed = shift();
      expect(removed).toBeUndefined();
      expect(items()).toEqual([]);
    });

    it("should unshift items", () => {
      const [items, { unshift }] = reactiveArray([2, 3]);
      unshift(0, 1);
      expect(items()).toEqual([0, 1, 2, 3]);
    });
  });

  // ---------------------------------------------------------------------------
  // splice / remove / removeWhere
  // ---------------------------------------------------------------------------
  describe("splice / remove / removeWhere", () => {
    it("should splice items (delete and insert)", () => {
      const [items, { splice }] = reactiveArray([1, 2, 3, 4]);
      const removed = splice(1, 2, 10, 20);
      expect(removed).toEqual([2, 3]);
      expect(items()).toEqual([1, 10, 20, 4]);
    });

    it("should splice with only deletion", () => {
      const [items, { splice }] = reactiveArray([1, 2, 3]);
      const removed = splice(0, 1);
      expect(removed).toEqual([1]);
      expect(items()).toEqual([2, 3]);
    });

    it("should splice with only insertion", () => {
      const [items, { splice }] = reactiveArray([1, 3]);
      const removed = splice(1, 0, 2);
      expect(removed).toEqual([]);
      expect(items()).toEqual([1, 2, 3]);
    });

    it("should remove by index", () => {
      const [items, { remove }] = reactiveArray(["a", "b", "c"]);
      remove(1);
      expect(items()).toEqual(["a", "c"]);
    });

    it("should ignore remove with out-of-bounds index", () => {
      const [items, { remove }] = reactiveArray([1, 2]);
      remove(10);
      expect(items()).toEqual([1, 2]);
    });

    it("should ignore remove with negative index", () => {
      const [items, { remove }] = reactiveArray([1, 2]);
      remove(-1);
      expect(items()).toEqual([1, 2]);
    });

    it("should removeWhere the first matching item", () => {
      const [items, { removeWhere }] = reactiveArray([1, 2, 3, 4]);
      removeWhere((x) => x === 3);
      expect(items()).toEqual([1, 2, 4]);
    });

    it("should only remove the first match with removeWhere", () => {
      const [items, { removeWhere }] = reactiveArray([1, 2, 2, 3]);
      removeWhere((x) => x === 2);
      expect(items()).toEqual([1, 2, 3]);
    });

    it("should do nothing when removeWhere finds no match", () => {
      const [items, { removeWhere }] = reactiveArray([1, 2, 3]);
      removeWhere((x) => x === 99);
      expect(items()).toEqual([1, 2, 3]);
    });
  });

  // ---------------------------------------------------------------------------
  // update / updateWhere
  // ---------------------------------------------------------------------------
  describe("update / updateWhere", () => {
    it("should update item at a specific index", () => {
      const [items, { update }] = reactiveArray(["a", "b", "c"]);
      update(1, "B");
      expect(items()).toEqual(["a", "B", "c"]);
    });

    it("should ignore update with out-of-bounds index", () => {
      const [items, { update }] = reactiveArray([1, 2]);
      update(5, 99);
      expect(items()).toEqual([1, 2]);
    });

    it("should not notify when update value is identical (Object.is)", () => {
      const [items, { update }] = reactiveArray([1, 2, 3]);
      const callback = vi.fn();
      track(() => {
        items();
      }, callback);

      callback.mockClear();
      update(0, 1); // same value
      expect(callback).not.toHaveBeenCalled();
      expect(items()).toEqual([1, 2, 3]);
    });

    it("should updateWhere matching items", () => {
      const [items, { updateWhere }] = reactiveArray([1, 2, 3, 4]);
      updateWhere(
        (x) => x % 2 === 0,
        (x) => x * 10,
      );
      expect(items()).toEqual([1, 20, 3, 40]);
    });

    it("should not notify when updateWhere produces identical values", () => {
      const [items, { updateWhere }] = reactiveArray([1, 2, 3]);
      const callback = vi.fn();
      track(() => {
        items();
      }, callback);

      callback.mockClear();
      updateWhere(
        (x) => x === 2,
        (x) => x,
      ); // identity updater
      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // sort / reverse / filter / map
  // ---------------------------------------------------------------------------
  describe("sort / reverse / filter / map", () => {
    it("should sort the array", () => {
      const [items, { sort }] = reactiveArray([3, 1, 2]);
      sort((a, b) => a - b);
      expect(items()).toEqual([1, 2, 3]);
    });

    it("should sort without a comparator", () => {
      const [items, { sort }] = reactiveArray([3, 1, 2]);
      sort();
      expect(items()).toEqual([1, 2, 3]);
    });

    it("should reverse the array", () => {
      const [items, { reverse }] = reactiveArray([1, 2, 3]);
      reverse();
      expect(items()).toEqual([3, 2, 1]);
    });

    it("should filter the array in-place", () => {
      const [items, { filter }] = reactiveArray([1, 2, 3, 4, 5]);
      filter((x) => x % 2 !== 0);
      expect(items()).toEqual([1, 3, 5]);
    });

    it("should not notify when filter removes nothing", () => {
      const [items, { filter }] = reactiveArray([1, 2, 3]);
      const callback = vi.fn();
      track(() => {
        items();
      }, callback);

      callback.mockClear();
      filter(() => true); // all pass
      expect(callback).not.toHaveBeenCalled();
      expect(items()).toEqual([1, 2, 3]);
    });

    it("should map and transform all items", () => {
      const [items, { map }] = reactiveArray([1, 2, 3]);
      map((x) => x * 2);
      expect(items()).toEqual([2, 4, 6]);
    });

    it("should not notify when map returns identical values", () => {
      const [items, { map }] = reactiveArray([1, 2, 3]);
      const callback = vi.fn();
      track(() => {
        items();
      }, callback);

      callback.mockClear();
      map((x) => x); // identity
      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // clear / set
  // ---------------------------------------------------------------------------
  describe("clear / set", () => {
    it("should clear all items", () => {
      const [items, { clear }] = reactiveArray([1, 2, 3]);
      clear();
      expect(items()).toEqual([]);
    });

    it("should set a new array", () => {
      const [items, { set }] = reactiveArray([1, 2]);
      set([10, 20, 30]);
      expect(items()).toEqual([10, 20, 30]);
    });

    it("should not mutate the array passed to set", () => {
      const [_items, { set, push }] = reactiveArray<number>([]);
      const source = [1, 2, 3];
      set(source);
      push(4);
      expect(source).toEqual([1, 2, 3]);
    });
  });

  // ---------------------------------------------------------------------------
  // Frozen / immutable snapshots
  // ---------------------------------------------------------------------------
  describe("frozen snapshots", () => {
    it("should return a frozen array", () => {
      const [items] = reactiveArray([1, 2, 3]);
      const snapshot = items();
      expect(Object.isFrozen(snapshot)).toBe(true);
    });

    it("should throw when attempting to mutate the snapshot", () => {
      const [items] = reactiveArray([1, 2, 3]);
      const snapshot = items();
      expect(() => {
        (snapshot as unknown as number[]).push(4);
      }).toThrow();
      expect(() => {
        (snapshot as unknown as number[])[0] = 99;
      }).toThrow();
    });

    it("should return the same reference on consecutive reads without mutations", () => {
      const [items] = reactiveArray([1, 2, 3]);
      const first = items();
      const second = items();
      expect(first).toBe(second);
    });

    it("should return a new reference after a mutation", () => {
      const [items, { push }] = reactiveArray([1, 2, 3]);
      const before = items();
      push(4);
      const after = items();
      expect(before).not.toBe(after);
      expect(after).toEqual([1, 2, 3, 4]);
    });
  });

  // ---------------------------------------------------------------------------
  // No-op operations should not trigger updates
  // ---------------------------------------------------------------------------
  describe("no-op operations", () => {
    it("should not notify on push with no items", () => {
      const [items, { push }] = reactiveArray([1, 2]);
      const callback = vi.fn();
      track(() => {
        items();
      }, callback);

      callback.mockClear();
      push();
      expect(callback).not.toHaveBeenCalled();
    });

    it("should not notify on unshift with no items", () => {
      const [items, { unshift }] = reactiveArray([1, 2]);
      const callback = vi.fn();
      track(() => {
        items();
      }, callback);

      callback.mockClear();
      unshift();
      expect(callback).not.toHaveBeenCalled();
    });

    it("should not notify on clear of an empty array", () => {
      const [items, { clear }] = reactiveArray<number>([]);
      const callback = vi.fn();
      track(() => {
        items();
      }, callback);

      callback.mockClear();
      clear();
      expect(callback).not.toHaveBeenCalled();
    });

    it("should not notify on pop of an empty array", () => {
      const [items, { pop }] = reactiveArray<number>([]);
      const callback = vi.fn();
      track(() => {
        items();
      }, callback);

      callback.mockClear();
      pop();
      expect(callback).not.toHaveBeenCalled();
    });

    it("should not notify on shift of an empty array", () => {
      const [items, { shift }] = reactiveArray<number>([]);
      const callback = vi.fn();
      track(() => {
        items();
      }, callback);

      callback.mockClear();
      shift();
      expect(callback).not.toHaveBeenCalled();
    });

    it("should not notify on sort of 0 or 1 element array", () => {
      const [items1, actions1] = reactiveArray<number>([]);
      const cb1 = vi.fn();
      track(() => {
        items1();
      }, cb1);
      cb1.mockClear();
      actions1.sort();
      expect(cb1).not.toHaveBeenCalled();

      const [items2, actions2] = reactiveArray([42]);
      const cb2 = vi.fn();
      track(() => {
        items2();
      }, cb2);
      cb2.mockClear();
      actions2.sort();
      expect(cb2).not.toHaveBeenCalled();
    });

    it("should not notify on reverse of 0 or 1 element array", () => {
      const [items, actions] = reactiveArray([42]);
      const callback = vi.fn();
      track(() => {
        items();
      }, callback);

      callback.mockClear();
      actions.reverse();
      expect(callback).not.toHaveBeenCalled();
    });

    it("should not notify on splice that does nothing", () => {
      const [items, { splice }] = reactiveArray([1, 2, 3]);
      const callback = vi.fn();
      track(() => {
        items();
      }, callback);

      callback.mockClear();
      splice(1, 0); // no deletion, no insertion
      expect(callback).not.toHaveBeenCalled();
    });

    it("should not notify on removeWhere with no match", () => {
      const [items, { removeWhere }] = reactiveArray([1, 2, 3]);
      const callback = vi.fn();
      track(() => {
        items();
      }, callback);

      callback.mockClear();
      removeWhere((x) => x === 99);
      expect(callback).not.toHaveBeenCalled();
    });

    it("should not notify on remove with out-of-bounds index", () => {
      const [items, { remove }] = reactiveArray([1, 2]);
      const callback = vi.fn();
      track(() => {
        items();
      }, callback);

      callback.mockClear();
      remove(10);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Reactive tracking
  // ---------------------------------------------------------------------------
  describe("reactive tracking", () => {
    it("should trigger subscriber when items change", () => {
      const [items, { push }] = reactiveArray([1, 2]);
      const callback = vi.fn();

      track(() => {
        items();
      }, callback);
      expect(callback).not.toHaveBeenCalled();

      push(3);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("should trigger subscriber on multiple sequential mutations", () => {
      const [items, { push, pop }] = reactiveArray<number>([1]);
      const callback = vi.fn();

      track(() => {
        items();
      }, callback);

      push(2);
      expect(callback).toHaveBeenCalledTimes(1);

      pop();
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("should stop triggering after teardown", () => {
      const [items, { push }] = reactiveArray<number>([]);
      const callback = vi.fn();

      const teardown = track(() => {
        items();
      }, callback);

      push(1);
      expect(callback).toHaveBeenCalledTimes(1);

      teardown();

      push(2);
      expect(callback).toHaveBeenCalledTimes(1); // not called again
    });

    it("should reflect the latest value inside the subscriber", () => {
      const [items, { push }] = reactiveArray<number>([1]);
      const snapshots: readonly number[][] = [];

      track(
        () => {
          items();
        },
        () => {
          (snapshots as unknown as number[][]).push([...items()]);
        },
      );

      push(2);
      push(3);
      expect(snapshots).toEqual([
        [1, 2],
        [1, 2, 3],
      ]);
    });
  });
});
