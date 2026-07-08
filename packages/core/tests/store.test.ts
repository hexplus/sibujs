import { describe, expect, it } from "vitest";
import { store } from "../src/core/signals/store";

describe("store", () => {
  it("initializes with the provided state and updates via setState", () => {
    const [s, { setState }] = store({ count: 0, text: "hello" });

    // initial values
    expect(s.count).toBe(0);
    expect(s.text).toBe("hello");

    // patch with object
    setState({ count: 5 });
    expect(s.count).toBe(5);
    expect(s.text).toBe("hello");

    // patch with updater function
    setState((s) => ({ ...s, text: "world" }));
    expect(s.count).toBe(5);
    expect(s.text).toBe("world");
  });

  it("resets to the initial state", () => {
    const [s, { setState, reset }] = store({ foo: 1 });
    setState({ foo: 42 });
    expect(s.foo).toBe(42);

    reset();
    expect(s.foo).toBe(1);
  });

  it("does not crash when reading inherited Object.prototype keys", () => {
    const [s] = store({ count: 0 });
    // `prop in signals` walked the prototype chain and crashed invoking
    // signals["constructor"][0]() — these reads must be safe now.
    expect(() => (s as Record<string, unknown>).constructor).not.toThrow();
    // Inherited members fall through to a normal object (not the signal tuples).
    expect((s as Record<string, unknown>).constructor).toBe(Object);
    expect(typeof (s as Record<string, unknown>).toString).toBe("function");
    // Real data key still works; an unknown data key is undefined.
    expect(s.count).toBe(0);
    expect((s as Record<string, unknown>).nope).toBeUndefined();
    // String coercion (which reads toString) must not throw.
    expect(() => String(s)).not.toThrow();
  });

  it("ignores setState patches targeting inherited / dangerous keys", () => {
    const [s, { setState }] = store({ count: 1 });
    expect(() => setState({ toString: "x", constructor: "y", __proto__: "z" } as never)).not.toThrow();
    // Real key still updates; prototype is untouched.
    setState({ count: 2 });
    expect(s.count).toBe(2);
    expect(({} as Record<string, unknown>).z).toBeUndefined();
    expect(Object.prototype.toString).toBe(Object.prototype.toString);
  });
});
