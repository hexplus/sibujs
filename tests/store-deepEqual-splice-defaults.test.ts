import { afterEach, describe, expect, it, vi } from "vitest";
import { array, reactiveArray } from "../src/core/signals/array";
import { deepEqual, deepSignal } from "../src/core/signals/deepSignal";
import { effect } from "../src/core/signals/effect";
import { store } from "../src/core/signals/store";
import { validateProps, validators } from "../src/patterns/contracts";

// ---------------------------------------------------------------------------
// store() own reserved keys, deepEqual() on opaque built-ins, native splice()
// semantics, and prop defaults that respect explicit null.
// ---------------------------------------------------------------------------

describe("store() represents own reserved-looking keys", () => {
  // THE DEFECT: the signal registry and snapshots were ordinary objects filled
  // by assignment, so `registry["__proto__"] = …` replaced the registry's
  // prototype instead of installing an own signal, and the key vanished.
  const RESERVED = ["__proto__", "constructor", "toString"] as const;

  for (const key of RESERVED) {
    it(`initializes, reads, updates, resets, snapshots and subscribes ${JSON.stringify(key)}`, () => {
      const initial = JSON.parse(`{"${key}":{"enabled":true},"count":1}`) as Record<string, unknown>;
      const [state, actions] = store(initial);

      expect(Object.hasOwn(actions.getSnapshot(), key)).toBe(true);
      expect((state as Record<string, unknown>)[key]).toEqual({ enabled: true });

      const seen: unknown[] = [];
      const stop = actions.subscribeKey(key, (value) => seen.push(value));
      actions.setState(JSON.parse(`{"${key}":{"enabled":false}}`));
      expect((state as Record<string, unknown>)[key]).toEqual({ enabled: false });
      expect(seen).toEqual([{ enabled: false }]);

      actions.reset();
      expect(actions.getSnapshot()[key]).toEqual({ enabled: true });
      expect(Object.getPrototypeOf(actions.getSnapshot())).toBe(Object.prototype);
      stop();
    });
  }

  it("leaves Object.prototype and inherited reads intact", () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const [state, actions] = store(JSON.parse('{"__proto__":{"polluted":true},"a":1}'));

    actions.setState({ a: 2 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
    // A store without its own "constructor" still behaves like an object.
    expect(typeof String(state)).toBe("string");
  });
});

describe("deepEqual() does not equate distinct opaque built-ins", () => {
  // THE DEFECT: after the handled built-ins, the fallback compared enumerable
  // keys, so any two instances with no enumerable state compared equal and a
  // deepSignal suppressed real updates.
  it("boxed primitives compare by value", () => {
    expect(deepEqual(new Number(1), new Number(2))).toBe(false);
    expect(deepEqual(new Number(1), new Number(1))).toBe(true);
    expect(deepEqual(new String("a"), new String("b"))).toBe(false);
    expect(deepEqual(new String("a"), new String("a"))).toBe(true);
    expect(deepEqual(new Boolean(true), new Boolean(false))).toBe(false);
    expect(deepEqual(new Boolean(false), new Boolean(false))).toBe(true);
  });

  it("URLs compare by their full href", () => {
    expect(deepEqual(new URL("https://a.test"), new URL("https://b.test"))).toBe(false);
    expect(deepEqual(new URL("https://a.test/x?y#z"), new URL("https://a.test/x?y#w"))).toBe(false);
    expect(deepEqual(new URL("https://a.test/x"), new URL("https://a.test/x"))).toBe(true);
  });

  it("Errors compare name, message and cause", () => {
    expect(deepEqual(new Error("first"), new Error("second"))).toBe(false);
    expect(deepEqual(new Error("same"), new Error("same"))).toBe(true);
    expect(deepEqual(new TypeError("same"), new RangeError("same"))).toBe(false);
    expect(deepEqual(new Error("x", { cause: 1 }), new Error("x", { cause: 2 }))).toBe(false);
    expect(deepEqual(new Error("x", { cause: { a: 1 } }), new Error("x", { cause: { a: 1 } }))).toBe(true);
    const named = new Error("x");
    named.name = "Custom";
    expect(deepEqual(named, new Error("x"))).toBe(false);
  });

  it("promises, weak collections and opaque class instances are equal only to themselves", () => {
    const p = Promise.resolve(1);
    expect(deepEqual(p, Promise.resolve(1))).toBe(false);
    expect(deepEqual(p, p)).toBe(true);
    expect(deepEqual(new WeakMap(), new WeakMap())).toBe(false);
    expect(deepEqual(new WeakSet(), new WeakSet())).toBe(false);

    class Handle {
      #secret: number;
      constructor(secret: number) {
        this.#secret = secret;
      }
      get secret() {
        return this.#secret;
      }
    }
    expect(deepEqual(new Handle(1), new Handle(2))).toBe(false);
  });

  it("supported structures keep structural equality", () => {
    expect(deepEqual(new Date(5), new Date(5))).toBe(true);
    expect(deepEqual(new Map([[1, { a: 1 }]]), new Map([[1, { a: 1 }]]))).toBe(true);
    expect(deepEqual(new Set([1, 2]), new Set([1, 2]))).toBe(true);
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(deepEqual([1, { b: [2] }], [1, { b: [2] }])).toBe(true);
    expect(deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toBe(true);
    expect(deepEqual(Object.assign(Object.create(null), { a: 1 }), Object.assign(Object.create(null), { a: 1 }))).toBe(
      true,
    );
  });

  it("a deepSignal notifies when a URL changes", () => {
    const [url, setUrl] = deepSignal(new URL("https://a.test"));
    const seen: string[] = [];
    const stop = effect(() => {
      seen.push(url().href);
    });

    setUrl(new URL("https://b.test"));

    expect(seen).toEqual(["https://a.test/", "https://b.test/"]);
    stop();
  });
});

describe("splice() follows native array semantics", () => {
  // THE DEFECT: both implementations defaulted an omitted `deleteCount` to 0,
  // while native `splice(start)` deletes through the end.
  const IMPLS = [
    { name: "array", make: <T>(v: T[]) => array(v) },
    { name: "reactiveArray", make: <T>(v: T[]) => reactiveArray(v) },
  ] as const;

  type Case = { label: string; call: (a: number[]) => number[] };
  const CASES: Case[] = [
    { label: "omitted deleteCount", call: (a) => a.splice(2) },
    { label: "explicit undefined deleteCount", call: (a) => a.splice(1, undefined) },
    { label: "negative start", call: (a) => a.splice(-2) },
    { label: "out-of-range start", call: (a) => a.splice(10) },
    { label: "very negative start", call: (a) => a.splice(-10, 2) },
    { label: "zero deletion with inserts", call: (a) => a.splice(1, 0, 9, 8) },
    { label: "delete with inserts", call: (a) => a.splice(1, 2, 7) },
  ];

  for (const impl of IMPLS) {
    for (const c of CASES) {
      it(`${impl.name}: ${c.label} matches Array.prototype.splice`, () => {
        const native = [1, 2, 3, 4];
        const expectedRemoved = c.call(native);

        const [items, ops] = impl.make([1, 2, 3, 4]);
        const notifications = vi.fn();
        const stop = effect(() => {
          notifications(items().length);
        });
        notifications.mockClear();

        const removed = c.call(ops as unknown as number[]);

        expect(removed).toEqual(expectedRemoved);
        expect([...items()]).toEqual(native);
        const changed = expectedRemoved.length > 0 || native.length !== 4 || c.label.includes("inserts");
        expect(notifications).toHaveBeenCalledTimes(changed ? 1 : 0);
        stop();
      });
    }
  }
});

describe("validateProps defaults respect explicit null", () => {
  // THE DEFECT: defaults applied when `value == null`, so an explicit `null` was
  // replaced by the default even when the prop's validator accepts null.
  type P = { value: string | null; flag: boolean; count: number; text: string };
  const schema = {
    value: { default: "fallback", type: validators.optional(validators.string) },
    flag: { default: true },
    count: { default: 5 },
    text: { default: "default text" },
  };

  function inBothModes(run: () => void): void {
    const g = globalThis as Record<string, unknown>;
    const had = "__SIBU_DEV__" in g;
    const prev = g.__SIBU_DEV__;
    try {
      for (const mode of [true, false]) {
        g.__SIBU_DEV__ = mode;
        run();
      }
    } finally {
      if (had) g.__SIBU_DEV__ = prev;
      else delete g.__SIBU_DEV__;
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("an absent property receives the default", () => {
    inBothModes(() => {
      expect(validateProps<P>({}, schema).value).toBe("fallback");
    });
  });

  it("an explicit undefined receives the default", () => {
    inBothModes(() => {
      expect(validateProps<P>({ value: undefined }, schema).value).toBe("fallback");
    });
  });

  it("an explicit null is preserved, and the nullable validator does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    inBothModes(() => {
      expect(validateProps<P>({ value: null }, schema).value).toBeNull();
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("false, 0 and the empty string are preserved", () => {
    inBothModes(() => {
      const result = validateProps<P>({ flag: false, count: 0, text: "" }, schema);
      expect(result.flag).toBe(false);
      expect(result.count).toBe(0);
      expect(result.text).toBe("");
    });
  });
});
