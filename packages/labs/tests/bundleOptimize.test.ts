import { describe, expect, it, vi } from "vitest";
import { conditional, devOnly, Features, noSideEffect, pure } from "../src/performance/bundleOptimize";

describe("bundleOptimize", () => {
  describe("pure", () => {
    it("invokes the factory and returns its result", () => {
      const fn = vi.fn(() => 42);
      expect(pure(fn)).toBe(42);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("returns object identity from the factory", () => {
      const obj = { a: 1 };
      expect(pure(() => obj)).toBe(obj);
    });
  });

  describe("conditional", () => {
    it("invokes the loader when condition is true", () => {
      const loader = vi.fn(() => "loaded");
      expect(conditional(true, loader)).toBe("loaded");
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it("returns undefined and skips the loader when condition is false", () => {
      const loader = vi.fn(() => "loaded");
      expect(conditional(false, loader)).toBeUndefined();
      expect(loader).not.toHaveBeenCalled();
    });
  });

  describe("Features", () => {
    it("exposes boolean feature flags", () => {
      expect(typeof Features.SSR).toBe("boolean");
      expect(typeof Features.DEV).toBe("boolean");
      expect(typeof Features.BROWSER).toBe("boolean");
    });

    it("SSR and BROWSER are mutually exclusive", () => {
      expect(Features.SSR).toBe(!Features.BROWSER);
    });
  });

  describe("devOnly", () => {
    it("invokes the callback when not in production", () => {
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      const fn = vi.fn();
      devOnly(fn);
      expect(fn).toHaveBeenCalledTimes(1);
      process.env.NODE_ENV = original;
    });

    it("does not invoke the callback in production", () => {
      const original = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      const fn = vi.fn();
      devOnly(fn);
      expect(fn).not.toHaveBeenCalled();
      process.env.NODE_ENV = original;
    });
  });

  describe("noSideEffect", () => {
    it("returns the same function reference", () => {
      const fn = (a: number, b: number) => a + b;
      const wrapped = noSideEffect(fn as (...args: unknown[]) => unknown);
      expect(wrapped).toBe(fn);
    });

    it("the wrapped function still works", () => {
      const fn = noSideEffect(((a: number) => a * 2) as (...args: unknown[]) => unknown);
      expect(fn(3)).toBe(6);
    });
  });
});
