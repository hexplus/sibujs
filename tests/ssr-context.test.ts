// ============================================================================
// ssr-context — nesting and exception-safety
// ============================================================================

import { describe, expect, it } from "vitest";
import { disableSSR, isSSR, withSSR } from "../src/core/ssr-context";

describe("withSSR", () => {
  it("enables SSR inside the callback and disables it after", () => {
    disableSSR();
    expect(isSSR()).toBe(false);

    const result = withSSR(() => {
      expect(isSSR()).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(isSSR()).toBe(false);
  });

  it("restores the original state even if the callback throws", () => {
    disableSSR();
    expect(isSSR()).toBe(false);

    expect(() =>
      withSSR(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(isSSR()).toBe(false);
  });

  it("is nesting-safe: inner withSSR does not turn off outer SSR", () => {
    disableSSR();
    withSSR(() => {
      expect(isSSR()).toBe(true);
      withSSR(() => {
        expect(isSSR()).toBe(true);
      });
      // After the inner call returns, the outer scope must still see SSR=true.
      expect(isSSR()).toBe(true);
    });
    expect(isSSR()).toBe(false);
  });

  it("nested withSSR exception still restores outer state", () => {
    disableSSR();
    withSSR(() => {
      expect(isSSR()).toBe(true);
      expect(() =>
        withSSR(() => {
          throw new Error("inner");
        }),
      ).toThrow("inner");
      // Outer scope remains in SSR mode
      expect(isSSR()).toBe(true);
    });
    expect(isSSR()).toBe(false);
  });
});
