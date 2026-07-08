import { describe, expect, it } from "vitest";
import { deepEqual, deepSignal } from "../src/core/signals/deepSignal";
import { effect } from "../src/core/signals/effect";

// ============================================================================
// deepEqual — unit tests
// ============================================================================

describe("deepEqual", () => {
  // ---- primitives ---------------------------------------------------------
  it("returns true for identical primitives", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "a")).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
  });

  it("returns false for different primitives", () => {
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual("a", "b")).toBe(false);
    expect(deepEqual(true, false)).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(0, false)).toBe(false);
  });

  it("handles NaN", () => {
    expect(deepEqual(NaN, NaN)).toBe(true);
  });

  it("distinguishes +0 and -0", () => {
    expect(deepEqual(+0, -0)).toBe(false);
  });

  // ---- flat objects -------------------------------------------------------
  it("flat objects: equal", () => {
    expect(deepEqual({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
  });

  it("flat objects: different value", () => {
    expect(deepEqual({ x: 1 }, { x: 2 })).toBe(false);
  });

  it("flat objects: different keys", () => {
    expect(deepEqual({ x: 1 }, { y: 1 })).toBe(false);
  });

  it("flat objects: different key count", () => {
    expect(deepEqual({ x: 1 }, { x: 1, y: 2 })).toBe(false);
  });

  // ---- nested objects -----------------------------------------------------
  it("deep objects: equal", () => {
    const a = { a: { b: { c: 1 } } };
    const b = { a: { b: { c: 1 } } };
    expect(deepEqual(a, b)).toBe(true);
  });

  it("deep objects: different leaf", () => {
    const a = { a: { b: { c: 1 } } };
    const b = { a: { b: { c: 2 } } };
    expect(deepEqual(a, b)).toBe(false);
  });

  // ---- arrays -------------------------------------------------------------
  it("arrays: equal", () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it("arrays: different element", () => {
    expect(deepEqual([1, 2, 3], [1, 2, 4])).toBe(false);
  });

  it("arrays: different length", () => {
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("nested arrays", () => {
    expect(deepEqual([[1, 2], [3]], [[1, 2], [3]])).toBe(true);
    expect(deepEqual([[1, 2], [3]], [[1, 2], [4]])).toBe(false);
  });

  // ---- Date ---------------------------------------------------------------
  it("dates: same timestamp", () => {
    expect(deepEqual(new Date("2024-01-01"), new Date("2024-01-01"))).toBe(true);
  });

  it("dates: different timestamp", () => {
    expect(deepEqual(new Date("2024-01-01"), new Date("2025-01-01"))).toBe(false);
  });

  it("date vs plain object → false (Bug #2 regression)", () => {
    expect(deepEqual(new Date(), {})).toBe(false);
  });

  it("date vs map → false (Bug #2 regression)", () => {
    expect(deepEqual(new Date(), new Map())).toBe(false);
  });

  // ---- RegExp -------------------------------------------------------------
  it("regex: same pattern and flags", () => {
    expect(deepEqual(/abc/gi, /abc/gi)).toBe(true);
  });

  it("regex: different pattern", () => {
    expect(deepEqual(/abc/, /def/)).toBe(false);
  });

  it("regex: different flags", () => {
    expect(deepEqual(/abc/i, /abc/g)).toBe(false);
  });

  it("regex vs plain object → false (Bug #2 regression)", () => {
    expect(deepEqual(/abc/, {})).toBe(false);
  });

  // ---- Map ----------------------------------------------------------------
  it("maps: equal entries", () => {
    expect(
      deepEqual(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
      ),
    ).toBe(true);
  });

  it("maps: different value (Bug #3 regression)", () => {
    expect(deepEqual(new Map([["a", 1]]), new Map([["a", 999]]))).toBe(false);
  });

  it("maps: different size", () => {
    expect(deepEqual(new Map([["a", 1]]), new Map())).toBe(false);
  });

  it("maps: deep value equality", () => {
    expect(deepEqual(new Map([["x", { nested: true }]]), new Map([["x", { nested: true }]]))).toBe(true);
  });

  // ---- Set ----------------------------------------------------------------
  it("sets: equal members", () => {
    expect(deepEqual(new Set([1, 2, 3]), new Set([1, 2, 3]))).toBe(true);
  });

  it("sets: different members (Bug #3 regression)", () => {
    expect(deepEqual(new Set([1, 2, 3]), new Set([99]))).toBe(false);
  });

  it("sets: different size", () => {
    expect(deepEqual(new Set([1]), new Set([1, 2]))).toBe(false);
  });

  it("map vs set → false", () => {
    expect(deepEqual(new Map(), new Set())).toBe(false);
  });

  // ---- TypedArrays --------------------------------------------------------
  it("typed arrays: equal", () => {
    expect(deepEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it("typed arrays: different", () => {
    expect(deepEqual(new Uint8Array([1, 2, 3]), new Uint8Array([9, 9, 9]))).toBe(false);
  });

  it("typed arrays: different length", () => {
    expect(deepEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  // ---- ArrayBuffer --------------------------------------------------------
  it("array buffers: equal", () => {
    const a = new Uint8Array([1, 2]).buffer;
    const b = new Uint8Array([1, 2]).buffer;
    expect(deepEqual(a, b)).toBe(true);
  });

  it("array buffers: different", () => {
    const a = new Uint8Array([1, 2]).buffer;
    const b = new Uint8Array([3, 4]).buffer;
    expect(deepEqual(a, b)).toBe(false);
  });

  // ---- Constructor mismatch -----------------------------------------------
  it("constructor mismatch → false (Bug #2 regression)", () => {
    class Foo {}
    class Bar {}
    expect(deepEqual(new Foo(), new Bar())).toBe(false);
  });

  // ---- Shared sub-references (Bug #1 regression) --------------------------
  it("shared sub-ref compared against different partner → false", () => {
    const shared = { x: 1 };
    const a = { left: shared, right: shared };
    const b = { left: shared, right: { x: 999 } };
    expect(deepEqual(a, b)).toBe(false);
  });

  it("shared sub-ref compared against identical partner → true", () => {
    const shared = { x: 1 };
    const a = { left: shared, right: shared };
    const b = { left: { x: 1 }, right: { x: 1 } };
    expect(deepEqual(a, b)).toBe(true);
  });

  // ---- Circular references (Bug #4 regression) ----------------------------
  it("symmetric cycles → true", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    const b: Record<string, unknown> = {};
    b.self = b;
    expect(deepEqual(a, b)).toBe(true);
  });

  it("asymmetric cycle vs different object → false", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(deepEqual(a, { self: { real: 1 } })).toBe(false);
  });

  it("cycle in nested structure", () => {
    const a: Record<string, unknown> = { val: 1 };
    a.next = { val: 2, next: a };
    const b: Record<string, unknown> = { val: 1 };
    b.next = { val: 2, next: b };
    expect(deepEqual(a, b)).toBe(true);
  });

  it("cycle in nested structure — different leaf", () => {
    const a: Record<string, unknown> = { val: 1 };
    a.next = { val: 2, next: a };
    const b: Record<string, unknown> = { val: 1 };
    b.next = { val: 999, next: b };
    expect(deepEqual(a, b)).toBe(false);
  });

  // ---- Mixed / edge cases -------------------------------------------------
  it("null vs object → false", () => {
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
  });

  it("array vs object → false", () => {
    expect(deepEqual([], {})).toBe(false);
  });

  it("empty objects → true", () => {
    expect(deepEqual({}, {})).toBe(true);
  });

  it("empty arrays → true", () => {
    expect(deepEqual([], [])).toBe(true);
  });
});

// ============================================================================
// deepSignal — integration tests
// ============================================================================

describe("deepSignal", () => {
  it("should hold initial value", () => {
    const [value] = deepSignal({ name: "Alice", age: 25 });
    expect(value()).toEqual({ name: "Alice", age: 25 });
  });

  it("should not notify when setting structurally identical object", () => {
    const [value, setValue] = deepSignal({ x: 1, y: 2 });
    let calls = 0;

    effect(() => {
      value();
      calls++;
    });

    expect(calls).toBe(1);

    // Set same structure — should not trigger
    setValue({ x: 1, y: 2 });
    expect(calls).toBe(1);
  });

  it("should notify when setting different object", () => {
    const [value, setValue] = deepSignal({ x: 1 });
    let calls = 0;

    effect(() => {
      value();
      calls++;
    });

    expect(calls).toBe(1);

    setValue({ x: 2 });
    expect(calls).toBe(2);
  });

  it("should handle arrays with deep equality", () => {
    const [arr, setArr] = deepSignal([1, 2, 3]);
    let calls = 0;

    effect(() => {
      arr();
      calls++;
    });

    expect(calls).toBe(1);

    // Same array — no notification
    setArr([1, 2, 3]);
    expect(calls).toBe(1);

    // Different array — notification
    setArr([1, 2, 4]);
    expect(calls).toBe(2);
  });

  it("should detect Map changes (Bug #3 regression)", () => {
    const [m, setM] = deepSignal(new Map([["a", 1]]));
    let calls = 0;

    effect(() => {
      m();
      calls++;
    });

    expect(calls).toBe(1);

    setM(new Map([["a", 1]]));
    expect(calls).toBe(1);

    setM(new Map([["a", 999]]));
    expect(calls).toBe(2);
  });

  it("should detect shared-ref differences (Bug #1 regression)", () => {
    const shared = { x: 1 };
    const [v, setV] = deepSignal({ left: shared, right: shared });
    let calls = 0;

    effect(() => {
      v();
      calls++;
    });

    expect(calls).toBe(1);

    // Same structure — no notification
    setV({ left: { x: 1 }, right: { x: 1 } });
    expect(calls).toBe(1);

    // Different right — should notify
    setV({ left: { x: 1 }, right: { x: 999 } });
    expect(calls).toBe(2);
  });
});
