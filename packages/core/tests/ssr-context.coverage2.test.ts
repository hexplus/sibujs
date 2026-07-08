// ============================================================================
// ssr-context.ts — extra coverage: enableSSR/disableSSR, getSSRStore via the
// AsyncLocalStorage path, request-scoped caches (multiple subsystems, reuse),
// withSSR nesting, runInSSRContext isolation and suspense-id reset.
// ============================================================================

import { afterEach, describe, expect, it } from "vitest";
import {
  disableSSR,
  enableSSR,
  getRequestScopedCache,
  getSSRStore,
  isSSR,
  runInSSRContext,
  withSSR,
} from "../src/core/ssr-context";

describe("ssr-context.ts coverage2", () => {
  afterEach(() => {
    disableSSR();
  });

  describe("enableSSR / disableSSR (module-global fallback store)", () => {
    it("enableSSR flips the flag on the fallback store and disableSSR clears it", () => {
      // Outside any ALS run() the store is the module-global fallback.
      disableSSR();
      expect(isSSR()).toBe(false);
      enableSSR();
      expect(isSSR()).toBe(true);
      expect(getSSRStore().ssr).toBe(true);
      disableSSR();
      expect(isSSR()).toBe(false);
    });
  });

  describe("getSSRStore inside runInSSRContext (ALS path on Node)", () => {
    it("returns the per-request store, not the fallback", () => {
      const fallback = getSSRStore();
      runInSSRContext(() => {
        const store = getSSRStore();
        expect(store.ssr).toBe(true);
        // On Node (ALS available) this is a distinct per-request store object.
        expect(store).not.toBe(fallback);
        expect(store.suspenseIdCounter).toBe(0);
      });
    });
  });

  describe("getRequestScopedCache", () => {
    it("creates and reuses a cache per subsystem within one request", () => {
      runInSSRContext(() => {
        const queryCache = getRequestScopedCache<number>("query");
        const otherCache = getRequestScopedCache<number>("router");
        expect(queryCache).not.toBeNull();
        expect(otherCache).not.toBeNull();
        // Distinct subsystems get distinct maps.
        expect(queryCache).not.toBe(otherCache);

        queryCache?.set("a", 1);
        // Re-fetching the same subsystem returns the same map (caches.get hit).
        const queryCache2 = getRequestScopedCache<number>("query");
        expect(queryCache2).toBe(queryCache);
        expect(queryCache2?.get("a")).toBe(1);
      });
    });

    it("returns null outside SSR (client uses a process-global cache)", () => {
      disableSSR();
      expect(getRequestScopedCache("query")).toBeNull();
    });

    it("works under the manual enableSSR fallback path too", () => {
      // No ALS run() — caches live on the fallback store.
      disableSSR();
      expect(getRequestScopedCache("query")).toBeNull();
      enableSSR();
      const cache = getRequestScopedCache<string>("query");
      expect(cache).not.toBeNull();
      cache?.set("k", "v");
      expect(getRequestScopedCache<string>("query")?.get("k")).toBe("v");
      disableSSR();
    });
  });

  describe("withSSR", () => {
    it("returns the callback value and toggles SSR around it", () => {
      disableSSR();
      const out = withSSR(() => {
        expect(isSSR()).toBe(true);
        return "result";
      });
      expect(out).toBe("result");
      expect(isSSR()).toBe(false);
    });

    it("preserves an already-on outer SSR flag when nested", () => {
      enableSSR();
      withSSR(() => {
        expect(isSSR()).toBe(true);
      });
      // Outer scope had SSR=true before, so it stays on.
      expect(isSSR()).toBe(true);
      disableSSR();
    });
  });

  describe("runInSSRContext", () => {
    it("returns the callback value and isolates suspense counters per request", () => {
      const a = runInSSRContext(() => {
        const store = getSSRStore();
        store.suspenseIdCounter += 5;
        return store.suspenseIdCounter;
      });
      expect(a).toBe(5);

      // A fresh request starts its counter back at 0.
      const b = runInSSRContext(() => getSSRStore().suspenseIdCounter);
      expect(b).toBe(0);
    });

    it("isolates request-scoped caches between concurrent requests", () => {
      let cacheA: Map<string, unknown> | null = null;
      let cacheB: Map<string, unknown> | null = null;
      runInSSRContext(() => {
        cacheA = getRequestScopedCache("query");
        cacheA?.set("secret", "A");
      });
      runInSSRContext(() => {
        cacheB = getRequestScopedCache("query");
      });
      expect(cacheA).not.toBe(cacheB);
      expect((cacheB as unknown as Map<string, unknown>).has("secret")).toBe(false);
    });
  });
});
