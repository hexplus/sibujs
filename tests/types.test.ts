/**
 * Type-level tests for SibuJS public API inference.
 *
 * These tests don't run at runtime — they verify TypeScript inference at compile time.
 * If any inference is wrong, `tsc --noEmit` will fail with a type error.
 *
 * Convention: `expectType<Expected>(actual)` asserts the type matches.
 */
import { describe, expect, it } from "vitest";
import { array } from "../src/core/signals/array";
import { deepSignal } from "../src/core/signals/deepSignal";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { ref } from "../src/core/signals/ref";
import { signal } from "../src/core/signals/signal";
import { store } from "../src/core/signals/store";
import { watch } from "../src/core/signals/watch";

// ── Helper: compile-time type assertion ──────────────────────────────────────

/** Asserts that T is exactly U (not just assignable) */
type IsExact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;

/** Compile-time assertion — fails if types don't match */
function expectType<T>(_value: T): void {}

/** Compile-time exact type check */
function _assertExact<T, U>(_proof: IsExact<T, U> extends true ? true : never): void {}

// ── signal inference ───────────────────────────────────────────────────────

describe("signal type inference", () => {
  it("infers number from number literal", () => {
    const [get, set] = signal(0);

    // Getter returns number
    const val: number = get();
    expectType<number>(get());

    // Setter accepts number or updater
    set(5);
    set((prev) => {
      expectType<number>(prev);
      return prev + 1;
    });

    expect(val).toBe(0);
  });

  it("infers string from string literal", () => {
    const [get, set] = signal("hello");
    expectType<string>(get());
    expect(get()).toBe("hello");
    set("world");
    expect(get()).toBe("world");
    set((prev) => {
      expectType<string>(prev);
      return prev.toUpperCase();
    });
    expect(get()).toBe("WORLD");
  });

  it("infers boolean from boolean literal", () => {
    const [get, set] = signal(true);
    expectType<boolean>(get());
    expect(get()).toBe(true);
    set(false);
    expect(get()).toBe(false);
  });

  it("infers complex object type", () => {
    const [get, set] = signal({ name: "Alice", age: 30, active: true });
    const val = get();

    expectType<string>(val.name);
    expectType<number>(val.age);
    expectType<boolean>(val.active);

    set({ name: "Bob", age: 25, active: false });
    expect(val.name).toBe("Alice");
  });

  it("infers array type", () => {
    const [get, set] = signal([1, 2, 3]);
    expectType<number[]>(get());
    expect(get()).toEqual([1, 2, 3]);

    set((prev) => {
      expectType<number[]>(prev);
      return [...prev, 4];
    });
    expect(get()).toEqual([1, 2, 3, 4]);
  });

  it("infers union type from explicit generic", () => {
    const [get, set] = signal<string | null>(null);
    expectType<string | null>(get());
    set("hello");
    set(null);
    expect(get()).toBeNull();
  });
});

// ── derived inference ──────────────────────────────────────────────────────

describe("derived type inference", () => {
  it("infers return type from getter function", () => {
    const [count] = signal(5);
    const doubled = derived(() => count() * 2);

    expectType<number>(doubled());
    expect(doubled()).toBe(10);
  });

  it("infers string from string-returning getter", () => {
    const [name] = signal("Alice");
    const greeting = derived(() => `Hello, ${name()}`);

    expectType<string>(greeting());
    expect(greeting()).toBe("Hello, Alice");
  });

  it("infers complex return type", () => {
    const [count] = signal(0);
    const result = derived(() => ({
      value: count(),
      label: `Count: ${count()}`,
      isZero: count() === 0,
    }));

    const val = result();
    expectType<number>(val.value);
    expectType<string>(val.label);
    expectType<boolean>(val.isZero);
    expect(val.isZero).toBe(true);
  });
});

// ── watch inference ────────────────────────────────────────────────────────

describe("watch type inference", () => {
  it("infers callback parameters from getter return type", () => {
    const [count] = signal(0);

    const teardown = watch(
      () => count(),
      (newVal, oldVal) => {
        expectType<number>(newVal);
        // oldVal is T | undefined on first call
        expectType<number | undefined>(oldVal);
      },
    );

    // Returns teardown function
    expectType<() => void>(teardown);
    teardown();
  });

  it("infers string type through watch", () => {
    const [name] = signal("Alice");

    const teardown = watch(
      () => name(),
      (newVal, oldVal) => {
        expectType<string>(newVal);
        expectType<string | undefined>(oldVal);
      },
    );
    teardown();
  });
});

// ── store inference ────────────────────────────────────────────────────────

describe("store type inference", () => {
  it("infers full shape from initial state", () => {
    const [s, actions] = store({ count: 0, name: "Alice", active: true });

    expectType<number>(s.count);
    expectType<string>(s.name);
    expectType<boolean>(s.active);

    // setState accepts partial
    actions.setState({ count: 5 });
    // setState accepts updater
    actions.setState((state) => {
      expectType<number>(state.count);
      expectType<string>(state.name);
      return { ...state, count: state.count + 1 };
    });

    // getSnapshot returns full shape
    const snap = actions.getSnapshot();
    expectType<number>(snap.count);
    expectType<string>(snap.name);

    expect(s.count).toBe(6);
  });
});

// ── ref inference ──────────────────────────────────────────────────────────

describe("ref type inference", () => {
  it("infers type from initial value", () => {
    const r = ref(42);
    expectType<number>(r.current);
    expect(r.current).toBe(42);
  });

  it("infers undefined when no initial value", () => {
    const r = ref<HTMLDivElement>();
    expectType<HTMLDivElement | undefined>(r.current);
    expect(r.current).toBeUndefined();
  });
});

// ── array inference ────────────────────────────────────────────────────────

describe("array type inference", () => {
  it("infers item type from initial array", () => {
    const [items, actions] = array([1, 2, 3]);
    expectType<number[]>(items());
    expect(items()).toEqual([1, 2, 3]);

    actions.push(4);
    expect(items()).toEqual([1, 2, 3, 4]);

    actions.set([10, 20]);
    expect(items()).toEqual([10, 20]);

    actions.update(0, 99);
    expect(items()).toEqual([99, 20]);
  });

  it("infers complex item type", () => {
    const [items] = array([{ id: 1, name: "Alice" }]);
    const first = items()[0];
    expectType<number>(first.id);
    expectType<string>(first.name);
    expect(first.name).toBe("Alice");
  });
});

// ── deepSignal inference ───────────────────────────────────────────────────

describe("deepSignal type inference", () => {
  it("infers object type with deep equality", () => {
    const [get, set] = deepSignal({ x: 1, y: 2 });
    const val = get();
    expectType<number>(val.x);
    expectType<number>(val.y);

    set({ x: 3, y: 4 });
    set((prev) => {
      expectType<{ x: number; y: number }>(prev);
      return { x: prev.x + 1, y: prev.y + 1 };
    });

    expect(get().x).toBe(4);
  });
});

// ── effect inference ───────────────────────────────────────────────────────

describe("effect type inference", () => {
  it("returns a teardown function", () => {
    const teardown = effect(() => {});
    expectType<() => void>(teardown);
    teardown();
  });
});
