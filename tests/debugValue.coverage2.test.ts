import { afterEach, describe, expect, it } from "vitest";
import { clearDebugValues, debugValue, getDebugValues } from "../src/devtools/debugValue";

// Covers the dispose function returned by debugValue: stopping the effect and
// splicing the entry out of the registry.

describe("debugValue dispose", () => {
  afterEach(() => {
    clearDebugValues();
  });

  it("removes the entry from the registry when disposed", () => {
    const stopA = debugValue(() => "a");
    debugValue(() => "b");

    expect(getDebugValues()).toHaveLength(2);

    stopA();

    const remaining = getDebugValues();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].value).toBe("b");
  });

  it("is safe to dispose twice", () => {
    const stop = debugValue(() => 1);
    stop();
    expect(() => stop()).not.toThrow();
    expect(getDebugValues()).toHaveLength(0);
  });
});
