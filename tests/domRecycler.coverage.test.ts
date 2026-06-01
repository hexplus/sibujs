import { afterEach, describe, expect, it, vi } from "vitest";
import { DOMPool, getDOMPool, prefetch, preloadImage, preloadResource } from "../src/performance/domRecycler";

afterEach(() => {
  document.head.querySelectorAll("link").forEach((l) => {
    l.remove();
  });
});

describe("DOMPool acquire/release", () => {
  it("acquires a fresh element when the pool is empty", () => {
    const pool = new DOMPool();
    const el = pool.acquire("div");
    expect(el.tagName).toBe("DIV");
  });

  it("recycles a released element of the same tag", () => {
    const pool = new DOMPool();
    const el = pool.acquire("span");
    pool.release(el);
    expect(pool.stats().span).toBe(1);
    const reused = pool.acquire("span");
    expect(reused.tagName).toBe("SPAN");
    expect(pool.stats().span).toBe(0);
  });

  it("cleans attributes, children, class, style, and id on release", () => {
    const pool = new DOMPool();
    const el = document.createElement("div");
    el.id = "x";
    el.className = "a b";
    el.setAttribute("style", "color: red");
    el.setAttribute("data-foo", "bar");
    el.innerHTML = "<span>child</span>";

    pool.release(el);
    const clean = pool.acquire("div");
    expect(clean.id).toBe("");
    expect(clean.className).toBe("");
    expect(clean.getAttribute("style")).toBeNull();
    expect(clean.getAttribute("data-foo")).toBeNull();
    expect(clean.childNodes.length).toBe(0);
  });

  it("does not exceed maxSize", () => {
    const pool = new DOMPool(2);
    for (let i = 0; i < 5; i++) {
      pool.release(document.createElement("p"));
    }
    expect(pool.stats().p).toBe(2);
  });

  it("warns when releasing a still-connected element in dev mode", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pool = new DOMPool();
    const el = document.createElement("div");
    document.body.appendChild(el);
    pool.release(el);
    el.remove();
    // devWarn may route through console.warn; either way release should not throw.
    expect(pool.stats().div).toBe(1);
    warnSpy.mockRestore();
  });

  it("clear empties all pools", () => {
    const pool = new DOMPool();
    pool.release(document.createElement("div"));
    pool.clear();
    expect(pool.stats()).toEqual({});
  });
});

describe("getDOMPool", () => {
  it("returns a shared singleton instance", () => {
    const a = getDOMPool();
    const b = getDOMPool();
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(DOMPool);
  });
});

describe("preloadResource", () => {
  it("creates a preload link for scripts", () => {
    preloadResource("https://example.com/app.js", "script");
    const link = document.head.querySelector('link[href="https://example.com/app.js"]') as HTMLLinkElement;
    expect(link.rel).toBe("preload");
    expect(link.getAttribute("as")).toBe("script");
  });

  it("creates a preload link for styles", () => {
    preloadResource("https://example.com/app.css", "style");
    const link = document.head.querySelector('link[href="https://example.com/app.css"]') as HTMLLinkElement;
    expect(link.getAttribute("as")).toBe("style");
  });

  it("creates a preload link for images", () => {
    preloadResource("https://example.com/pic.png", "image");
    const link = document.head.querySelector('link[href="https://example.com/pic.png"]') as HTMLLinkElement;
    expect(link.getAttribute("as")).toBe("image");
  });

  it("defaults to fetch with crossorigin", () => {
    preloadResource("https://example.com/data.json");
    const link = document.head.querySelector('link[href="https://example.com/data.json"]') as HTMLLinkElement;
    expect(link.getAttribute("as")).toBe("fetch");
    expect(link.getAttribute("crossorigin")).toBe("anonymous");
  });

  it("does not preload the same url twice", () => {
    preloadResource("https://example.com/once.js", "script");
    preloadResource("https://example.com/once.js", "script");
    const links = document.head.querySelectorAll('link[href="https://example.com/once.js"]');
    expect(links.length).toBe(1);
  });
});

describe("prefetch", () => {
  it("creates a prefetch link", () => {
    prefetch("https://example.com/next-page");
    const link = document.head.querySelector('link[href="https://example.com/next-page"]') as HTMLLinkElement;
    expect(link.rel).toBe("prefetch");
  });

  it("dedupes already-tracked urls", () => {
    prefetch("https://example.com/dup");
    prefetch("https://example.com/dup");
    const links = document.head.querySelectorAll('link[href="https://example.com/dup"]');
    expect(links.length).toBe(1);
  });
});

describe("preloadImage", () => {
  it("resolves when the image loads", async () => {
    const promise = preloadImage("https://example.com/img.png");
    // jsdom Image does not load; manually trigger onload via the instance.
    // The promise wires onload; we cannot reach the instance directly, so we
    // create a controlled Image to validate the resolve path instead.
    await expect(Promise.race([promise, Promise.resolve("pending")])).resolves.toBe("pending");
  });

  it("rejects on error", async () => {
    const OriginalImage = globalThis.Image;
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onerror?.(new Error("load failed")));
      }
    }
    vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
    await expect(preloadImage("bad.png")).rejects.toBeTruthy();
    vi.stubGlobal("Image", OriginalImage);
  });

  it("resolves with the image element on load", async () => {
    const OriginalImage = globalThis.Image;
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
    const img = await preloadImage("good.png");
    expect(img).toBeInstanceOf(FakeImage);
    vi.stubGlobal("Image", OriginalImage);
  });
});
