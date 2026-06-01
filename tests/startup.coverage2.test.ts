import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBootSequence,
  createSSRCache,
  deferNonCritical,
  preloadCritical,
  prerenderRoutes,
} from "../src/plugins/startup";

describe("startup optimizations coverage", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("preloadCritical", () => {
    it("appends preload link tags with type and crossOrigin", () => {
      preloadCritical([
        { href: "/app.js", as: "script", type: "text/javascript", crossOrigin: "anonymous" },
        { href: "/style.css", as: "style" },
      ]);
      const links = document.head.querySelectorAll('link[rel="preload"]');
      expect(links.length).toBe(2);
      const script = document.head.querySelector('link[href="/app.js"]') as HTMLLinkElement;
      expect(script.getAttribute("as")).toBe("script");
      expect(script.type).toBe("text/javascript");
      expect(script.crossOrigin).toBe("anonymous");
    });

    it("skips duplicate hrefs", () => {
      preloadCritical([{ href: "/dup.js", as: "script" }]);
      preloadCritical([{ href: "/dup.js", as: "script" }]);
      expect(document.head.querySelectorAll('link[href="/dup.js"]').length).toBe(1);
    });

    it("uses the manual escape fallback when CSS.escape is unavailable", () => {
      const realCSS = (globalThis as { CSS?: unknown }).CSS;
      (globalThis as { CSS?: unknown }).CSS = undefined;
      try {
        preloadCritical([{ href: '/weird".js', as: "script" }]);
        expect(document.head.querySelectorAll('link[rel="preload"]').length).toBe(1);
      } finally {
        (globalThis as { CSS?: unknown }).CSS = realCSS;
      }
    });
  });

  describe("prerenderRoutes", () => {
    const comp = (text: string) => () => {
      const el = document.createElement("div");
      el.textContent = text;
      return el;
    };

    it("prerenders routes and serves cached HTML", () => {
      const pr = prerenderRoutes([
        { path: "/", component: comp("home") },
        { path: "/about", component: comp("about") },
      ]);
      expect(pr.has("/")).toBe(true);
      expect(pr.get("/")).toContain("home");
      expect(pr.get("/missing")).toBeUndefined();
      expect(pr.has("/missing")).toBe(false);
      expect(pr.stats().size).toBe(2);
      expect(pr.stats().routes).toContain("/about");
    });

    it("invalidate and clear remove cached routes", () => {
      const pr = prerenderRoutes([{ path: "/x", component: comp("x") }]);
      pr.invalidate("/x");
      expect(pr.has("/x")).toBe(false);
      const pr2 = prerenderRoutes([{ path: "/y", component: comp("y") }]);
      pr2.clear();
      expect(pr2.stats().size).toBe(0);
    });

    it("expires entries based on TTL", () => {
      vi.useFakeTimers();
      const base = 1_000_000;
      vi.setSystemTime(base);
      const pr = prerenderRoutes([{ path: "/ttl", component: comp("ttl") }], { cacheTTL: 100 });
      expect(pr.get("/ttl")).toContain("ttl");
      vi.setSystemTime(base + 200);
      expect(pr.get("/ttl")).toBeUndefined();
      expect(pr.has("/ttl")).toBe(false);
      // stats cleans up expired entries when TTL is active.
      expect(pr.stats().size).toBe(0);
    });

    it("stats() prunes expired entries when TTL is active", () => {
      vi.useFakeTimers();
      const base = 2_000_000;
      vi.setSystemTime(base);
      const pr = prerenderRoutes([{ path: "/p", component: comp("p") }], { cacheTTL: 100 });
      vi.setSystemTime(base + 500);
      // stats() walks the cache and deletes expired entries before reporting.
      expect(pr.stats().size).toBe(0);
    });

    it("evicts the oldest entry when over max cache size", () => {
      vi.useFakeTimers();
      let t = 1000;
      vi.setSystemTime(t);
      // maxCacheSize 1 forces eviction on the second route.
      const routes = [
        { path: "/one", component: comp("one") },
        { path: "/two", component: comp("two") },
      ];
      // Stagger timestamps so the oldest is well-defined.
      const orig = Date.now;
      vi.spyOn(Date, "now").mockImplementation(() => {
        t += 10;
        return t;
      });
      const pr = prerenderRoutes(routes, { maxCacheSize: 1 });
      Date.now = orig;
      // Only one entry should remain after eviction.
      expect(pr.stats().size).toBe(1);
    });
  });

  describe("createSSRCache", () => {
    it("stores, retrieves, and tracks hit/miss stats", () => {
      const cache = createSSRCache();
      expect(cache.get("a")).toBeUndefined(); // miss
      cache.set("a", "<p>A</p>");
      expect(cache.get("a")).toBe("<p>A</p>"); // hit
      expect(cache.has("a")).toBe(true);
      const stats = cache.stats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.size).toBe(1);
    });

    it("expires entries by TTL and counts the expiry as a miss", () => {
      vi.useFakeTimers();
      const base = 5_000_000;
      vi.setSystemTime(base);
      const cache = createSSRCache({ defaultTTL: 50 });
      cache.set("k", "html");
      expect(cache.has("k")).toBe(true);
      vi.setSystemTime(base + 100);
      expect(cache.get("k")).toBeUndefined();
      expect(cache.has("k")).toBe(false);
      expect(cache.stats().misses).toBe(1);
    });

    it("treats ttl 0 as no expiry", () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const cache = createSSRCache();
      cache.set("forever", "html", 0);
      vi.setSystemTime(10_000_000);
      expect(cache.get("forever")).toBe("html");
    });

    it("invalidate and clear remove entries and reset stats", () => {
      const cache = createSSRCache();
      cache.set("a", "x");
      cache.invalidate("a");
      expect(cache.has("a")).toBe(false);
      cache.get("a"); // miss
      cache.clear();
      const stats = cache.stats();
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it("evicts the oldest entry when at max size", () => {
      let t = 100;
      vi.spyOn(Date, "now").mockImplementation(() => {
        t += 10;
        return t;
      });
      const cache = createSSRCache({ maxSize: 2 });
      cache.set("a", "A");
      cache.set("b", "B");
      cache.set("c", "C"); // triggers eviction of oldest ("a")
      expect(cache.stats().size).toBe(2);
      expect(cache.has("a")).toBe(false);
      expect(cache.has("c")).toBe(true);
    });
  });

  describe("deferNonCritical", () => {
    it("returns immediately for an empty task list", () => {
      expect(() => deferNonCritical([])).not.toThrow();
    });

    it("runs all tasks via setTimeout fallback", async () => {
      const realRIC = (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
      (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = undefined;
      vi.useFakeTimers();
      try {
        const a = vi.fn();
        const b = vi.fn();
        deferNonCritical([a, b]);
        vi.advanceTimersByTime(2);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
      } finally {
        (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = realRIC;
      }
    });

    it("continues after a failing task and logs the error", async () => {
      const realRIC = (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
      (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = undefined;
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.useFakeTimers();
      try {
        const good = vi.fn();
        deferNonCritical([
          () => {
            throw new Error("task boom");
          },
          good,
        ]);
        vi.advanceTimersByTime(2);
        expect(good).toHaveBeenCalledTimes(1);
        expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Deferred task failed"), expect.any(Error));
      } finally {
        (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = realRIC;
      }
    });

    it("reschedules remaining tasks when the idle deadline runs out", () => {
      const calls: Array<(deadline?: { timeRemaining: () => number }) => void> = [];
      const fakeRIC = vi.fn((cb: (deadline?: { timeRemaining: () => number }) => void) => {
        calls.push(cb);
        return 0;
      });
      (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = fakeRIC;
      try {
        const a = vi.fn();
        const b = vi.fn();
        deferNonCritical([a, b]);
        // First invocation: deadline has no time, so it should reschedule
        // before running any task.
        calls[0]({ timeRemaining: () => 0 });
        expect(a).not.toHaveBeenCalled();
        expect(fakeRIC).toHaveBeenCalledTimes(2);
        // Second invocation with plenty of time runs all tasks.
        calls[1]({ timeRemaining: () => 50 });
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
      } finally {
        (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = undefined;
      }
    });
  });

  describe("createBootSequence", () => {
    it("runs critical tasks first then deferred, recording timing", async () => {
      const seq = createBootSequence();
      const order: string[] = [];
      seq.critical("c1", () => {
        order.push("c1");
      });
      seq.critical("c2", async () => {
        order.push("c2");
      });
      seq.defer("d1", () => {
        order.push("d1");
      });
      const result = await seq.boot();
      expect(order).toEqual(["c1", "c2", "d1"]);
      expect(result.errors).toEqual([]);
      expect(Object.keys(result.timing)).toEqual(["c1", "c2", "d1"]);
    });

    it("collects errors from critical and deferred tasks without aborting", async () => {
      const seq = createBootSequence();
      seq.critical("good", () => {});
      seq.critical("bad-critical", () => {
        throw new Error("crit fail");
      });
      seq.defer("bad-defer", () => {
        throw "string fail";
      });
      const result = await seq.boot();
      expect(result.errors.length).toBe(2);
      const names = result.errors.map((e) => e.name);
      expect(names).toContain("bad-critical");
      expect(names).toContain("bad-defer");
      // Non-Error throwable wrapped into Error.
      const deferErr = result.errors.find((e) => e.name === "bad-defer");
      expect(deferErr?.error).toBeInstanceOf(Error);
      expect(deferErr?.error.message).toBe("string fail");
    });
  });
});
