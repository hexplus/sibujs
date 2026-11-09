import { describe, expect, it } from "vitest";
import { type ArrayActions, array, reactiveArray } from "../../src/core/signals/array";
import { effect } from "../../src/core/signals/effect";

const boom = new Error("boom");

const countRuns = (read: () => unknown) => {
  const counter = { runs: 0, stop: () => {} };
  counter.stop = effect(() => {
    read();
    counter.runs++;
  });
  return counter;
};

describe("reactiveArray map and updateWhere commit all or nothing (audit F9)", () => {
  it("a throwing map leaves no hidden write for a later mutation to expose", () => {
    const [items, actions] = reactiveArray([1, 2]);
    const before = items();

    expect(() =>
      actions.map((value) => {
        if (value === 2) throw boom;
        return value + 10;
      }),
    ).toThrow(boom);

    expect(items()).toBe(before);
    actions.push(3);
    expect(items()).toEqual([1, 2, 3]);
  });

  it("a throwing updater leaves earlier matches unwritten", () => {
    const [items, actions] = reactiveArray([1, 2, 3]);

    expect(() =>
      actions.updateWhere(
        () => true,
        (value) => {
          if (value === 2) throw boom;
          return value + 10;
        },
      ),
    ).toThrow(boom);

    actions.push(4);
    expect(items()).toEqual([1, 2, 3, 4]);
  });

  it("a throwing predicate leaves earlier matches unwritten", () => {
    const [items, actions] = reactiveArray([1, 2, 3]);

    expect(() =>
      actions.updateWhere(
        (value) => {
          if (value === 2) throw boom;
          return true;
        },
        (value) => value + 10,
      ),
    ).toThrow(boom);

    actions.reverse();
    expect(items()).toEqual([3, 2, 1]);
  });

  it("does not notify subscribers when the transform throws", () => {
    const [items, actions] = reactiveArray([1, 2]);
    const reader = countRuns(items);

    expect(() =>
      actions.map(() => {
        throw boom;
      }),
    ).toThrow(boom);
    reader.stop();

    expect(reader.runs).toBe(1);
  });

  it("works normally after a failed transform", () => {
    const [items, actions] = reactiveArray([1, 2]);
    expect(() =>
      actions.map(() => {
        throw boom;
      }),
    ).toThrow(boom);

    actions.map((value) => value * 2);

    expect(items()).toEqual([2, 4]);
  });

  it("shows callbacks the array as it was before the transform", () => {
    const [items, actions] = reactiveArray([1, 2]);
    const seen: Array<readonly number[]> = [];

    actions.map((value) => {
      seen.push([...items()]);
      return value + 10;
    });

    expect(seen).toEqual([
      [1, 2],
      [1, 2],
    ]);
    expect(items()).toEqual([11, 12]);
  });
});

describe("reactiveArray successful transforms keep their contract (audit F9)", () => {
  it("map commits a new snapshot, notifies once and passes the index", () => {
    const [items, actions] = reactiveArray([5, 6]);
    const before = items();
    const reader = countRuns(items);
    const indexes: number[] = [];

    actions.map((value, index) => {
      indexes.push(index);
      return value + 1;
    });
    reader.stop();

    expect(items()).toEqual([6, 7]);
    expect(Object.isFrozen(items())).toBe(true);
    expect(before).toEqual([5, 6]);
    expect(indexes).toEqual([0, 1]);
    expect(reader.runs).toBe(2);
  });

  it("updateWhere changes only matching items and notifies once", () => {
    const [items, actions] = reactiveArray([1, 2, 3, 4]);
    const reader = countRuns(items);

    actions.updateWhere(
      (value) => value % 2 === 0,
      (value) => value * 10,
    );
    reader.stop();

    expect(items()).toEqual([1, 20, 3, 40]);
    expect(reader.runs).toBe(2);
  });

  it("keeps the snapshot and stays silent when nothing changes", () => {
    const [items, actions] = reactiveArray([1, 2]);
    const before = items();
    const reader = countRuns(items);

    actions.map((value) => value);
    actions.updateWhere(
      () => false,
      (value) => value + 1,
    );
    actions.updateWhere(
      () => true,
      (value) => value,
    );
    reader.stop();

    expect(items()).toBe(before);
    expect(reader.runs).toBe(1);
  });

  it("treats NaN mapped to NaN as unchanged and -0 from 0 as a change", () => {
    const [items, actions] = reactiveArray([Number.NaN, 0]);
    const before = items();

    actions.map((value) => value);
    expect(items()).toBe(before);

    actions.map((value) => (value === 0 ? -0 : value));
    expect(Object.is(items()[1], -0)).toBe(true);
  });
});

describe("reactiveArray transforms during reentrant writes (audit F9)", () => {
  type Create = (initial: number[]) => [() => readonly number[], ArrayActions<number>];

  const popDuringMap = (create: Create, readFirst: boolean) => {
    const [items, actions] = create([1, 2, 3]);
    if (readFirst) items();
    let first = true;
    actions.map((value) => {
      if (first) {
        first = false;
        actions.pop();
      }
      return value * 10;
    });
    return items();
  };

  it.each([false, true])("a pop during map leaves no holes, as array() does (snapshot cached: %s)", (readFirst) => {
    const result = popDuringMap(reactiveArray, readFirst);

    expect([...result]).toEqual(popDuringMap(array, readFirst));
    expect(Object.keys(result)).toHaveLength(result.length);
  });

  it("does not visit an item pushed during map", () => {
    const [items, actions] = reactiveArray([1, 2]);
    const visited: number[] = [];

    actions.map((value) => {
      visited.push(value);
      if (visited.length === 1) actions.push(99);
      return value * 10;
    });

    expect(visited).toEqual([1, 2]);
    expect(items()).toEqual([10, 20]);
  });

  it.each([false, true])("keeps a write made during a no-op map (snapshot cached: %s)", (readFirst) => {
    const [items, actions] = reactiveArray([1, 2, 3]);
    if (readFirst) items();

    actions.map((value, index) => {
      if (index === 0) actions.pop();
      return value;
    });

    expect(items()).toEqual([1, 2]);
  });

  it.each([false, true])("keeps a write made during a no-op updateWhere (snapshot cached: %s)", (readFirst) => {
    const [items, actions] = reactiveArray([1, 2, 3]);
    if (readFirst) items();
    let first = true;

    actions.updateWhere(
      () => true,
      (value) => {
        if (first) {
          first = false;
          actions.pop();
        }
        return value;
      },
    );

    expect(items()).toEqual([1, 2]);
  });
});
