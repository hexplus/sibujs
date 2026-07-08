import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChunkRegistry, lazyChunk, preloadModule, preloadModules } from "../src/performance/chunkLoader";

// ─── createChunkRegistry ────────────────────────────────────────────────────

describe("createChunkRegistry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should load a chunk via the loader", async () => {
    const registry = createChunkRegistry();
    const loader = vi.fn().mockResolvedValue("chunk-data");

    const result = await registry.load("a", loader);

    expect(result).toBe("chunk-data");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("should return cached value on second load", async () => {
    const registry = createChunkRegistry();
    const loader = vi.fn().mockResolvedValue("chunk-data");

    await registry.load("a", loader);
    const result = await registry.load("a", loader);

    expect(result).toBe("chunk-data");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("should evict the oldest entry when cache is full", async () => {
    const registry = createChunkRegistry({ maxCacheSize: 2 });

    await registry.load("a", () => Promise.resolve("data-a"));
    await registry.load("b", () => Promise.resolve("data-b"));

    // This should evict "a" since it is the oldest
    await registry.load("c", () => Promise.resolve("data-c"));

    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(true);
    expect(registry.has("c")).toBe(true);
  });

  it("should expire cached entries after TTL", async () => {
    const registry = createChunkRegistry({ cacheTTL: 5000 });
    const loader = vi.fn().mockResolvedValue("data");

    await registry.load("a", loader);
    expect(registry.has("a")).toBe(true);

    // Advance time past TTL
    vi.advanceTimersByTime(6000);

    expect(registry.has("a")).toBe(false);
    // Loading again should call the loader a second time
    await registry.load("a", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("should deduplicate concurrent requests for the same chunk", async () => {
    vi.useRealTimers();

    const loader = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50, "data")));
    const registry = createChunkRegistry();

    const p1 = registry.load("a", loader);
    const p2 = registry.load("a", loader);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe("data");
    expect(r2).toBe("data");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("should retry on failure and eventually succeed", async () => {
    vi.useRealTimers();

    let attempt = 0;
    const loader = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt < 3) return Promise.reject(new Error("fail"));
      return Promise.resolve("recovered");
    });

    const registry = createChunkRegistry({ retries: 2, retryDelay: 10 });
    const result = await registry.load("a", loader);

    expect(result).toBe("recovered");
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("should throw after exhausting retries", async () => {
    vi.useRealTimers();

    const loader = vi.fn().mockRejectedValue(new Error("always fails"));
    const registry = createChunkRegistry({ retries: 1, retryDelay: 10 });

    await expect(registry.load("a", loader)).rejects.toThrow("always fails");
    // 1 initial + 1 retry = 2
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("should preload a chunk silently", async () => {
    vi.useRealTimers();

    const registry = createChunkRegistry();
    const loader = vi.fn().mockResolvedValue("preloaded-data");

    registry.preload("a", loader);

    // Wait for the internal load to settle
    await new Promise((r) => setTimeout(r, 50));

    expect(registry.has("a")).toBe(true);
    expect(registry.get("a")).toBe("preloaded-data");
  });

  it("should not preload the same chunk twice", async () => {
    vi.useRealTimers();

    const registry = createChunkRegistry();
    const loader = vi.fn().mockResolvedValue("data");

    registry.preload("a", loader);
    registry.preload("a", loader);

    await new Promise((r) => setTimeout(r, 50));

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("should preloadAll multiple chunks", async () => {
    vi.useRealTimers();

    const registry = createChunkRegistry();
    const loaderA = vi.fn().mockResolvedValue("a");
    const loaderB = vi.fn().mockResolvedValue("b");

    registry.preloadAll([
      { id: "a", loader: loaderA },
      { id: "b", loader: loaderB },
    ]);

    await new Promise((r) => setTimeout(r, 50));

    expect(registry.has("a")).toBe(true);
    expect(registry.has("b")).toBe(true);
  });

  it("should invalidate a cached chunk", async () => {
    const registry = createChunkRegistry();
    await registry.load("a", () => Promise.resolve("data"));

    expect(registry.has("a")).toBe(true);
    registry.invalidate("a");
    expect(registry.has("a")).toBe(false);
  });

  it("should clear all cached chunks", async () => {
    const registry = createChunkRegistry();
    await registry.load("a", () => Promise.resolve("data-a"));
    await registry.load("b", () => Promise.resolve("data-b"));

    registry.clear();

    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(false);
    expect(registry.stats().size).toBe(0);
  });

  it("should return correct stats", async () => {
    const registry = createChunkRegistry({ maxCacheSize: 100 });
    await registry.load("a", () => Promise.resolve("data-a"));
    await registry.load("b", () => Promise.resolve("data-b"));

    const stats = registry.stats();
    expect(stats.size).toBe(2);
    expect(stats.maxSize).toBe(100);
    expect(stats.pending).toBe(0);
  });

  it("should call lifecycle hooks", async () => {
    const onLoadStart = vi.fn();
    const onLoadEnd = vi.fn();
    const onLoadError = vi.fn();

    const registry = createChunkRegistry({
      retries: 0,
      onLoadStart,
      onLoadEnd,
      onLoadError,
    });

    await registry.load("a", () => Promise.resolve("data"));
    expect(onLoadStart).toHaveBeenCalledWith("a");
    expect(onLoadEnd).toHaveBeenCalledWith("a");

    await registry.load("b", () => Promise.reject(new Error("boom"))).catch(() => {});
    expect(onLoadError).toHaveBeenCalledWith("b", expect.any(Error));
  });
});

// ─── lazyChunk ──────────────────────────────────────────────────────────────

describe("lazyChunk", () => {
  it("should create a lazy component that shows fallback then loads", async () => {
    const registry = createChunkRegistry();

    const loadedEl = document.createElement("span");
    loadedEl.textContent = "Loaded!";

    const loader = () => Promise.resolve({ default: () => loadedEl });

    const fallbackEl = document.createElement("div");
    fallbackEl.textContent = "Loading...";

    const component = lazyChunk("comp", loader, registry, () => fallbackEl);
    const container = component();

    // The container should have the data-chunk attribute
    expect(container.getAttribute("data-chunk")).toBe("comp");

    // Fallback should be rendered initially
    expect(container.textContent).toBe("Loading...");

    // Wait for the async load to complete
    await new Promise((r) => setTimeout(r, 50));

    // After loading, the content should be replaced
    expect(container.textContent).toBe("Loaded!");
  });

  it("should return cached component immediately if available", async () => {
    const registry = createChunkRegistry();

    const loadedEl = document.createElement("span");
    loadedEl.textContent = "Cached!";

    const componentFn = () => loadedEl;

    // Pre-populate the cache
    await registry.load("cached-comp", () => Promise.resolve(componentFn));

    const component = lazyChunk("cached-comp", () => Promise.resolve({ default: componentFn }), registry);

    const result = component();

    // Since it is cached, the result should be the direct element (not a container)
    expect(result.textContent).toBe("Cached!");
  });

  it("should show error message when loading fails", async () => {
    const registry = createChunkRegistry({ retries: 0 });

    const component = lazyChunk("fail-comp", () => Promise.reject(new Error("network error")), registry);

    const container = component();

    await new Promise((r) => setTimeout(r, 50));

    expect(container.textContent).toContain("Failed to load chunk");
    expect(container.textContent).toContain("network error");
  });
});

// ─── preloadModule / preloadModules ─────────────────────────────────────────

describe("preloadModule", () => {
  beforeEach(() => {
    // Clear any existing preload links
    document.head.querySelectorAll('link[rel="modulepreload"]').forEach((el) => {
      el.remove();
    });
  });

  it("should add a link[rel=modulepreload] to document head", () => {
    preloadModule("/chunk-a.js");

    const link = document.querySelector('link[rel="modulepreload"][href="/chunk-a.js"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute("rel")).toBe("modulepreload");
    expect(link?.getAttribute("href")).toBe("/chunk-a.js");
  });

  it("should not add duplicate preload links", () => {
    preloadModule("/chunk-b.js");
    preloadModule("/chunk-b.js");

    const links = document.querySelectorAll('link[rel="modulepreload"][href="/chunk-b.js"]');
    expect(links.length).toBe(1);
  });
});

describe("preloadModules", () => {
  beforeEach(() => {
    document.head.querySelectorAll('link[rel="modulepreload"]').forEach((el) => {
      el.remove();
    });
  });

  it("should preload multiple modules", () => {
    preloadModules(["/mod-a.js", "/mod-b.js", "/mod-c.js"]);

    const links = document.querySelectorAll('link[rel="modulepreload"]');
    expect(links.length).toBe(3);
  });
});
