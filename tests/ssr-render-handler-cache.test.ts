import { afterEach, describe, expect, it, vi } from "vitest";
import { p } from "../src/core/rendering/html";
import { query } from "../src/data/query";
import { createRenderHandler } from "../src/platform/renderHandler";
import type { RouteDef } from "../src/plugins/router";

// The render handler's page cache is shared by every visitor. A page is stored
// only when it is a 200/404 that did not time out AND its Cache-Control allows
// a shared cache (no `no-store`, `no-cache` or `private`); `x-sibu-cache` says
// `hit`, `miss` (rendered, stored) or `bypass` (rendered, not stored).

afterEach(() => {
  vi.restoreAllMocks();
});

const req = (path: string) => new Request(`http://x.test${path}`);

/** A page whose body changes on every render, and a counter of renders. */
function counting(): { routes: RouteDef[]; renders: () => number } {
  let n = 0;
  return {
    routes: [{ path: "/:page", component: () => p(`render ${++n}`) }],
    renders: () => n,
  };
}

describe("createRenderHandler's page cache honors Cache-Control", () => {
  it("renders a no-store page for every request, and says it bypassed the cache", async () => {
    const { routes, renders } = counting();
    const handle = createRenderHandler(routes, { cache: {}, cacheControl: () => "no-store" });
    const first = await handle(req("/a"));
    const second = await handle(req("/a"));
    expect(renders()).toBe(2);
    expect(await first.text()).toContain("render 1");
    expect(await second.text()).toContain("render 2");
    for (const res of [first, second]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-sibu-cache")).toBe("bypass");
    }
  });

  it("parses the directives: mixed case and combined forms count, look-alikes do not", async () => {
    for (const control of ["No-Store", "public, NO-STORE", "max-age=0,no-store", 'private="set-cookie"', "no-cache"]) {
      const { routes, renders } = counting();
      const handle = createRenderHandler(routes, { cache: {}, cacheControl: () => control });
      await handle(req("/a"));
      await handle(req("/a"));
      expect([control, renders()]).toEqual([control, 2]);
    }
    for (const control of ["public, max-age=60", "x-no-store-hint=1", "s-maxage=60"]) {
      const { routes, renders } = counting();
      const handle = createRenderHandler(routes, { cache: {}, cacheControl: () => control });
      await handle(req("/a"));
      const second = await handle(req("/a"));
      expect([control, renders(), second.headers.get("x-sibu-cache")]).toEqual([control, 1, "hit"]);
    }
  });

  it("keeps a private (personalized) page out of the shared cache: another visitor gets their own", async () => {
    let visitor = "ada";
    const routes: RouteDef[] = [{ path: "/me", component: () => p(`hello ${visitor}`) }];
    const handle = createRenderHandler(routes, { cache: {}, cacheControl: () => "private, max-age=0" });
    expect(await (await handle(req("/me"))).text()).toContain("hello ada");
    visitor = "bob";
    const bob = await handle(req("/me"));
    expect(await bob.text()).toContain("hello bob");
    expect(bob.headers.get("x-sibu-cache")).toBe("bypass");
  });

  it("still caches default public pages", async () => {
    const { routes, renders } = counting();
    const handle = createRenderHandler(routes, { cache: {} });
    const first = await handle(req("/a"));
    const second = await handle(req("/a"));
    expect(first.headers.get("x-sibu-cache")).toBe("miss");
    expect(second.headers.get("x-sibu-cache")).toBe("hit");
    expect(await second.text()).toContain("render 1");
    expect(renders()).toBe(1);
  });

  it("does not store timed-out or failed renders", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    const slow: RouteDef[] = [
      {
        path: "/slow",
        component: () => {
          n++;
          const q = query("never", () => new Promise<string>(() => {}));
          return p(() => q.data() ?? "loading");
        },
      },
    ];
    const handle = createRenderHandler(slow, { cache: {}, timeout: 20, cacheControl: () => "public, max-age=60" });
    expect((await handle(req("/slow"))).headers.get("x-sibu-cache")).toBe("bypass");
    expect((await handle(req("/slow"))).headers.get("x-sibu-cache")).toBe("bypass");
    expect(n).toBe(2);

    const failing = createRenderHandler([{ path: "/", component: () => p("x") }], {
      cache: {},
      app: () => {
        throw new Error("boom");
      },
    });
    const res = await failing(req("/"));
    expect(res.status).toBe(500);
    expect(res.headers.get("x-sibu-cache")).toBeNull();
  });

  it("keeps byte accounting right when storage is skipped and entries are evicted", async () => {
    // Every page is ~1 KB of text; the budget holds about four.
    const routes: RouteDef[] = [{ path: "/:page", component: () => p("x".repeat(1000)) }];
    let control = "public";
    const handle = createRenderHandler(routes, { cache: { maxBytes: 5000 }, cacheControl: () => control });
    for (const path of ["/1", "/2"]) expect((await handle(req(path))).headers.get("x-sibu-cache")).toBe("miss");
    control = "no-store";
    // Skipped pages take no budget…
    for (let i = 0; i < 10; i++) expect((await handle(req(`/skip${i}`))).headers.get("x-sibu-cache")).toBe("bypass");
    control = "public";
    expect((await handle(req("/1"))).headers.get("x-sibu-cache")).toBe("hit");
    expect((await handle(req("/2"))).headers.get("x-sibu-cache")).toBe("hit");
    // …and stored ones still evict the least recently used first.
    for (const path of ["/3", "/4", "/5"]) await handle(req(path));
    expect((await handle(req("/1"))).headers.get("x-sibu-cache")).toBe("miss");
    expect((await handle(req("/5"))).headers.get("x-sibu-cache")).toBe("hit");
  });
});
