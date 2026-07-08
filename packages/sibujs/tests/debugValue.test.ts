import { afterEach, describe, expect, it } from "vitest";
import { clearDebugValues, debugValue, getDebugValues } from "../src/devtools/debugValue";

describe("debugValue", () => {
  afterEach(() => {
    clearDebugValues();
  });

  it("registers a debug value with default string formatting", () => {
    debugValue(() => 42);

    const values = getDebugValues();
    expect(values).toHaveLength(1);
    expect(values[0].value).toBe(42);
    expect(values[0].label).toBe("42");
  });

  it("uses custom formatter when provided", () => {
    debugValue(
      () => ({ count: 5 }),
      (v) => `Count: ${v.count}`,
    );

    const values = getDebugValues();
    expect(values).toHaveLength(1);
    expect(values[0].label).toBe("Count: 5");
    expect(values[0].value).toEqual({ count: 5 });
  });

  it("registers multiple debug values", () => {
    debugValue(() => "hello");
    debugValue(() => 99);
    debugValue(() => true);

    const values = getDebugValues();
    expect(values).toHaveLength(3);
    expect(values[0].value).toBe("hello");
    expect(values[1].value).toBe(99);
    expect(values[2].value).toBe(true);
  });

  it("clearDebugValues removes all registered values", () => {
    debugValue(() => "test1");
    debugValue(() => "test2");

    expect(getDebugValues()).toHaveLength(2);

    clearDebugValues();

    expect(getDebugValues()).toHaveLength(0);
  });

  it("getDebugValues returns a copy of the array", () => {
    debugValue(() => "original");

    const values1 = getDebugValues();
    const values2 = getDebugValues();

    expect(values1).not.toBe(values2);
    expect(values1).toEqual(values2);
  });
});
