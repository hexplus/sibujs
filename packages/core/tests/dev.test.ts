import { afterEach, describe, expect, it, vi } from "vitest";
import { devAssert, devWarn, isDev } from "../src/core/dev";

describe("core/dev", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isDev", () => {
    it("returns a boolean", () => {
      expect(typeof isDev()).toBe("boolean");
    });

    it("returns true under the vitest/node test environment (NODE_ENV not production)", () => {
      // The default branch resolves to NODE_ENV !== "production". Under vitest
      // NODE_ENV is "test", so dev mode is on.
      expect(isDev()).toBe(true);
    });

    it("honours an explicit globalThis.__SIBU_DEV__ override (true)", () => {
      const g = globalThis as any;
      const had = "__SIBU_DEV__" in g;
      const prev = g.__SIBU_DEV__;
      g.__SIBU_DEV__ = true;
      try {
        expect(isDev()).toBe(true);
      } finally {
        if (had) g.__SIBU_DEV__ = prev;
        else delete g.__SIBU_DEV__;
      }
    });

    it("honours an explicit globalThis.__SIBU_DEV__ override (false)", () => {
      const g = globalThis as any;
      const had = "__SIBU_DEV__" in g;
      const prev = g.__SIBU_DEV__;
      g.__SIBU_DEV__ = false;
      try {
        expect(isDev()).toBe(false);
      } finally {
        if (had) g.__SIBU_DEV__ = prev;
        else delete g.__SIBU_DEV__;
      }
    });

    it("coerces a truthy global override to a strict boolean", () => {
      const g = globalThis as any;
      const had = "__SIBU_DEV__" in g;
      const prev = g.__SIBU_DEV__;
      g.__SIBU_DEV__ = 1;
      try {
        expect(isDev()).toBe(true);
      } finally {
        if (had) g.__SIBU_DEV__ = prev;
        else delete g.__SIBU_DEV__;
      }
    });

    it("coerces a falsy (zero) global override to false", () => {
      const g = globalThis as any;
      const had = "__SIBU_DEV__" in g;
      const prev = g.__SIBU_DEV__;
      g.__SIBU_DEV__ = 0;
      try {
        expect(isDev()).toBe(false);
      } finally {
        if (had) g.__SIBU_DEV__ = prev;
        else delete g.__SIBU_DEV__;
      }
    });
  });

  describe("devAssert", () => {
    it("does NOT throw when the condition is true", () => {
      expect(() => devAssert(true, "should not throw")).not.toThrow();
    });

    it("throws in dev mode when the condition is false", () => {
      // Module-cached _isDev is true under the test runner.
      expect(() => devAssert(false, "boom")).toThrow();
    });

    it("prefixes the thrown message with [SibuJS]", () => {
      expect(() => devAssert(false, "boom")).toThrow("[SibuJS] boom");
    });

    it("throws an Error instance", () => {
      let caught: unknown;
      try {
        devAssert(false, "kapow");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("[SibuJS] kapow");
    });
  });

  describe("devWarn", () => {
    it("calls console.warn in dev mode", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      devWarn("heads up");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("prefixes the warning message with [SibuJS]", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      devWarn("heads up");
      expect(spy).toHaveBeenCalledWith("[SibuJS] heads up");
    });

    it("does not throw", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(() => devWarn("safe")).not.toThrow();
    });
  });
});
