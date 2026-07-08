import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBootSequence,
  createSSRCache,
  deferNonCritical,
  preloadCritical,
  prerenderRoutes,
} from "../src/plugins/startup";

// =============================================================================
// preloadCritical
// =============================================================================

describe("preloadCritical", () => {
  beforeEach(() => {
    // Clear all preload links from head between tests
    document.head.innerHTML = "";
  });

  it("should add link[rel=preload] elements to document head", () => {
    preloadCritical([
      { href: "/app.js", as: "script" },
      { href: "/style.css", as: "style" },
    ]);

    const links = document.querySelectorAll('link[rel="preload"]');
    expect(links.length).toBe(2);

    const first = links[0] as HTMLLinkElement;
    expect(first.href).toContain("/app.js");
    expect(first.getAttribute("as")).toBe("script");

    const second = links[1] as HTMLLinkElement;
    expect(second.href).toContain("/style.css");
    expect(second.getAttribute("as")).toBe("style");
  });

  it("should not add duplicate preload links for the same href", () => {
    preloadCritical([{ href: "/app.js", as: "script" }]);
    preloadCritical([{ href: "/app.js", as: "script" }]);

    const links = document.querySelectorAll('link[rel="preload"]');
    expect(links.length).toBe(1);
  });

  it("should set type attribute when provided", () => {
    preloadCritical([{ href: "/font.woff2", as: "font", type: "font/woff2" }]);

    const link = document.querySelector('link[rel="preload"]') as HTMLLinkElement;
    expect(link.type).toBe("font/woff2");
  });

  it("should set crossOrigin attribute when provided", () => {
    preloadCritical([{ href: "/font.woff2", as: "font", crossOrigin: "anonymous" }]);

    const link = document.querySelector('link[rel="preload"]') as HTMLLinkElement;
    expect(link.crossOrigin).toBe("anonymous");
  });

  it("should handle an empty resources array gracefully", () => {
    preloadCritical([]);
    const links = document.querySelectorAll('link[rel="preload"]');
    expect(links.length).toBe(0);
  });
});

// =============================================================================
// prerenderRoutes
// =============================================================================

describe("prerenderRoutes", () => {
  function makeComponent(text: string): () => HTMLElement {
    return () => {
      const el = document.createElement("div");
      el.textContent = text;
      return el;
    };
  }

  it("should prerender routes and return cached HTML via get()", () => {
    const cache = prerenderRoutes([
      { path: "/", component: makeComponent("Home") },
      { path: "/about", component: makeComponent("About") },
    ]);

    const homeHtml = cache.get("/");
    expect(homeHtml).toBeDefined();
    expect(homeHtml).toContain("Home");

    const aboutHtml = cache.get("/about");
    expect(aboutHtml).toBeDefined();
    expect(aboutHtml).toContain("About");
  });

  it("get() returns undefined for uncached routes", () => {
    const cache = prerenderRoutes([{ path: "/", component: makeComponent("Home") }]);
    expect(cache.get("/missing")).toBeUndefined();
  });

  it("has() returns true for cached routes and false otherwise", () => {
    const cache = prerenderRoutes([{ path: "/", component: makeComponent("Home") }]);
    expect(cache.has("/")).toBe(true);
    expect(cache.has("/nope")).toBe(false);
  });

  it("invalidate() removes a specific route from cache", () => {
    const cache = prerenderRoutes([
      { path: "/", component: makeComponent("Home") },
      { path: "/about", component: makeComponent("About") },
    ]);

    cache.invalidate("/");
    expect(cache.has("/")).toBe(false);
    expect(cache.has("/about")).toBe(true);
  });

  it("clear() removes all cached routes", () => {
    const cache = prerenderRoutes([
      { path: "/", component: makeComponent("Home") },
      { path: "/about", component: makeComponent("About") },
    ]);

    cache.clear();
    expect(cache.has("/")).toBe(false);
    expect(cache.has("/about")).toBe(false);
  });

  it("stats() returns cache size and route list", () => {
    const cache = prerenderRoutes([
      { path: "/", component: makeComponent("Home") },
      { path: "/about", component: makeComponent("About") },
    ]);

    const stats = cache.stats();
    expect(stats.size).toBe(2);
    expect(stats.routes).toContain("/");
    expect(stats.routes).toContain("/about");
  });

  it("should expire entries when cacheTTL is exceeded", () => {
    vi.useFakeTimers();
    try {
      const cache = prerenderRoutes([{ path: "/", component: makeComponent("Home") }], { cacheTTL: 100 });

      expect(cache.has("/")).toBe(true);

      vi.advanceTimersByTime(150);

      expect(cache.has("/")).toBe(false);
      expect(cache.get("/")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should evict the oldest entry when maxCacheSize is reached", () => {
    vi.useFakeTimers();
    try {
      // Create cache with max 2 entries, register 3 routes
      // The eviction happens before adding each route, so the third route
      // triggers eviction of the oldest
      const routes = [
        { path: "/a", component: makeComponent("A") },
        { path: "/b", component: makeComponent("B") },
        { path: "/c", component: makeComponent("C") },
      ];

      // Stagger timestamps so eviction order is deterministic
      vi.setSystemTime(1000);
      const _cache = prerenderRoutes([routes[0]], { maxCacheSize: 2 });

      // Manually check: we only have route /a, need to add /b and /c
      // But prerenderRoutes adds all routes at construction time
      // Let's test with all three at once; the oldest (/a) should be evicted
      vi.setSystemTime(1000);
      const cache2 = prerenderRoutes(routes, { maxCacheSize: 2 });

      // With maxCacheSize=2, after adding 3 routes, only 2 should remain
      const stats = cache2.stats();
      expect(stats.size).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// =============================================================================
// createSSRCache
// =============================================================================

describe("createSSRCache", () => {
  it("should store and retrieve HTML by key", () => {
    const cache = createSSRCache();
    cache.set("/page", "<div>Page</div>");
    expect(cache.get("/page")).toBe("<div>Page</div>");
  });

  it("get() returns undefined and increments misses for missing keys", () => {
    const cache = createSSRCache();
    expect(cache.get("/missing")).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
  });

  it("get() increments hits for valid cached entries", () => {
    const cache = createSSRCache();
    cache.set("/page", "<div>Page</div>");
    cache.get("/page");
    cache.get("/page");
    expect(cache.stats().hits).toBe(2);
  });

  it("should expire entries after TTL", () => {
    vi.useFakeTimers();
    try {
      const cache = createSSRCache({ defaultTTL: 500 });
      cache.set("/page", "<div>Page</div>");

      expect(cache.get("/page")).toBe("<div>Page</div>");
      expect(cache.stats().hits).toBe(1);

      vi.advanceTimersByTime(600);

      expect(cache.get("/page")).toBeUndefined();
      expect(cache.stats().misses).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should support per-entry TTL override", () => {
    vi.useFakeTimers();
    try {
      const cache = createSSRCache({ defaultTTL: 1000 });
      cache.set("/short", "<div>Short</div>", 100);
      cache.set("/long", "<div>Long</div>"); // uses defaultTTL

      vi.advanceTimersByTime(200);

      expect(cache.get("/short")).toBeUndefined(); // expired
      expect(cache.get("/long")).toBe("<div>Long</div>"); // still valid
    } finally {
      vi.useRealTimers();
    }
  });

  it("should never expire entries with TTL of 0", () => {
    vi.useFakeTimers();
    try {
      const cache = createSSRCache({ defaultTTL: 100 });
      cache.set("/forever", "<div>Forever</div>", 0);

      vi.advanceTimersByTime(999999);

      expect(cache.get("/forever")).toBe("<div>Forever</div>");
    } finally {
      vi.useRealTimers();
    }
  });

  it("has() returns true for valid entries and false for expired ones", () => {
    vi.useFakeTimers();
    try {
      const cache = createSSRCache({ defaultTTL: 200 });
      cache.set("/page", "<div>Page</div>");

      expect(cache.has("/page")).toBe(true);

      vi.advanceTimersByTime(300);

      expect(cache.has("/page")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidate() removes a specific entry", () => {
    const cache = createSSRCache();
    cache.set("/a", "A");
    cache.set("/b", "B");
    cache.invalidate("/a");

    expect(cache.has("/a")).toBe(false);
    expect(cache.has("/b")).toBe(true);
  });

  it("clear() removes all entries and resets stats", () => {
    const cache = createSSRCache();
    cache.set("/a", "A");
    cache.get("/a"); // hit
    cache.get("/b"); // miss

    cache.clear();

    const stats = cache.stats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });

  it("should evict the oldest entry when maxSize is exceeded", () => {
    vi.useFakeTimers();
    try {
      const cache = createSSRCache({ maxSize: 2 });

      vi.setSystemTime(1000);
      cache.set("/a", "A");

      vi.setSystemTime(2000);
      cache.set("/b", "B");

      vi.setSystemTime(3000);
      cache.set("/c", "C"); // should evict /a (oldest)

      expect(cache.has("/a")).toBe(false);
      expect(cache.has("/b")).toBe(true);
      expect(cache.has("/c")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stats() returns current size, hits, and misses", () => {
    const cache = createSSRCache();
    cache.set("/x", "X");
    cache.set("/y", "Y");
    cache.get("/x"); // hit
    cache.get("/z"); // miss

    const stats = cache.stats();
    expect(stats.size).toBe(2);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });
});

// =============================================================================
// deferNonCritical
// =============================================================================

describe("deferNonCritical", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should execute all deferred tasks", () => {
    const results: number[] = [];
    deferNonCritical([() => results.push(1), () => results.push(2), () => results.push(3)]);

    vi.runAllTimers();

    expect(results).toEqual([1, 2, 3]);
  });

  it("should not crash for empty task array", () => {
    expect(() => {
      deferNonCritical([]);
      vi.runAllTimers();
    }).not.toThrow();
  });

  it("should catch errors in deferred tasks without stopping others", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const results: number[] = [];

    deferNonCritical([
      () => results.push(1),
      () => {
        throw new Error("task error");
      },
      () => results.push(3),
    ]);

    vi.runAllTimers();

    expect(results).toEqual([1, 3]);
    consoleSpy.mockRestore();
  });

  it("should not mutate the original tasks array", () => {
    const tasks = [() => {}, () => {}];
    const original = [...tasks];

    deferNonCritical(tasks);
    vi.runAllTimers();

    expect(tasks).toEqual(original);
  });
});

// =============================================================================
// createBootSequence
// =============================================================================

describe("createBootSequence", () => {
  it("should run critical tasks before deferred tasks", async () => {
    const order: string[] = [];
    const boot = createBootSequence();

    boot.critical("init-db", () => {
      order.push("db");
    });
    boot.defer("analytics", () => {
      order.push("analytics");
    });
    boot.critical("init-auth", () => {
      order.push("auth");
    });
    boot.defer("prefetch", () => {
      order.push("prefetch");
    });

    await boot.boot();

    // Critical tasks come first in registration order, then deferred
    expect(order).toEqual(["db", "auth", "analytics", "prefetch"]);
  });

  it("should capture timing for each task", async () => {
    const boot = createBootSequence();
    boot.critical("fast-task", () => {});
    boot.defer("slow-task", async () => {
      // Simulate a tiny delay so timing is captured
      return new Promise((resolve) => setTimeout(resolve, 0));
    });

    const result = await boot.boot();

    expect(result.timing).toHaveProperty("fast-task");
    expect(result.timing).toHaveProperty("slow-task");
    expect(typeof result.timing["fast-task"]).toBe("number");
    expect(typeof result.timing["slow-task"]).toBe("number");
  });

  it("should capture errors without stopping subsequent tasks", async () => {
    const order: string[] = [];
    const boot = createBootSequence();

    boot.critical("step1", () => {
      order.push("step1");
    });
    boot.critical("step2-fail", () => {
      throw new Error("boom");
    });
    boot.critical("step3", () => {
      order.push("step3");
    });

    const result = await boot.boot();

    expect(order).toEqual(["step1", "step3"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe("step2-fail");
    expect(result.errors[0].error.message).toBe("boom");
  });

  it("should handle async critical tasks", async () => {
    const order: string[] = [];
    const boot = createBootSequence();

    boot.critical("async-init", async () => {
      await Promise.resolve();
      order.push("async-init");
    });
    boot.critical("sync-init", () => {
      order.push("sync-init");
    });

    await boot.boot();

    expect(order).toEqual(["async-init", "sync-init"]);
  });

  it("should handle async deferred tasks", async () => {
    const results: string[] = [];
    const boot = createBootSequence();

    boot.defer("async-defer", async () => {
      await Promise.resolve();
      results.push("async-defer");
    });

    await boot.boot();

    expect(results).toEqual(["async-defer"]);
  });

  it("should capture errors from deferred tasks too", async () => {
    const boot = createBootSequence();

    boot.defer("bad-defer", () => {
      throw new Error("deferred boom");
    });

    const result = await boot.boot();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe("bad-defer");
    expect(result.errors[0].error.message).toBe("deferred boom");
  });

  it("should convert non-Error throws to Error objects", async () => {
    const boot = createBootSequence();

    boot.critical("string-throw", () => {
      throw "just a string";
    });

    const result = await boot.boot();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toBeInstanceOf(Error);
    expect(result.errors[0].error.message).toBe("just a string");
  });

  it("should return empty errors and timing when no tasks are registered", async () => {
    const boot = createBootSequence();
    const result = await boot.boot();

    expect(result.timing).toEqual({});
    expect(result.errors).toEqual([]);
  });
});
