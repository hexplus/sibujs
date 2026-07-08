// ============================================================================
// ssr-context — nesting and exception-safety
// ============================================================================

import { describe, expect, it } from "vitest";
import { disableSSR, getRequestScopedCache, isSSR, runInSSRContext, withSSR } from "../src/core/ssr-context";

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

describe("getRequestScopedCache (per-request data isolation)", () => {
  it("returns null on the client (process-global cache is correct there)", () => {
    disableSSR();
    expect(getRequestScopedCache("query")).toBeNull();
  });

  it("returns a stable cache within one request", () => {
    runInSSRContext(() => {
      const a = getRequestScopedCache("query");
      const b = getRequestScopedCache("query");
      expect(a).not.toBeNull();
      expect(a).toBe(b);
    });
  });

  it("isolates caches between concurrent SSR requests (no cross-request bleed)", () => {
    let cacheA: Map<string, unknown> | null = null;
    let cacheB: Map<string, unknown> | null = null;

    runInSSRContext(() => {
      cacheA = getRequestScopedCache<unknown>("query");
      cacheA?.set("profile", "user-A-secret");
    });
    runInSSRContext(() => {
      cacheB = getRequestScopedCache<unknown>("query");
    });

    expect(cacheA).not.toBe(cacheB);
    // Request B must NOT observe request A's cached data.
    expect((cacheB as unknown as Map<string, unknown>).has("profile")).toBe(false);
  });
});
