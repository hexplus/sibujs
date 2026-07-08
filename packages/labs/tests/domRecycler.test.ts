import { describe, expect, it } from "vitest";
import { DOMPool, getDOMPool, preloadResource } from "../src/performance/domRecycler";

describe("DOMPool", () => {
  it("should acquire a new element", () => {
    const pool = new DOMPool();
    const el = pool.acquire("div");
    expect(el.tagName.toLowerCase()).toBe("div");
  });

  it("should release and reuse elements", () => {
    const pool = new DOMPool();
    const el = pool.acquire("div");
    el.className = "test";
    el.textContent = "content";

    pool.release(el);

    const stats = pool.stats();
    expect(stats["div"]).toBe(1);
  });

  it("should clear all pools", () => {
    const pool = new DOMPool();
    const el = pool.acquire("span");
    pool.release(el);

    pool.clear();
    expect(pool.stats()).toEqual({});
  });

  it("should respect max pool size", () => {
    const pool = new DOMPool(2);
    for (let i = 0; i < 5; i++) {
      const el = pool.acquire("div");
      pool.release(el);
    }
    expect(pool.stats()["div"]).toBeLessThanOrEqual(2);
  });
});

describe("getDOMPool (global)", () => {
  it("should be available as a singleton", () => {
    expect(getDOMPool()).toBeInstanceOf(DOMPool);
    expect(getDOMPool()).toBe(getDOMPool());
  });
});

describe("preloadResource", () => {
  it("should add a preload link to head", () => {
    const before = document.head.querySelectorAll('link[rel="preload"]').length;
    preloadResource("/test-script.js", "script");
    const after = document.head.querySelectorAll('link[rel="preload"]').length;
    expect(after).toBeGreaterThan(before);
  });
});
