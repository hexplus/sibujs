import { afterEach, describe, expect, it, vi } from "vitest";
import { createStubFetch } from "../fixtures/ssr-app/src/api";
import { head, routes } from "../fixtures/ssr-app/src/routes";
import { each } from "../src/core/rendering/each";
import { div, li, p, ul } from "../src/core/rendering/html";
import { __resetQueryCache, query } from "../src/data/query";
import { resource } from "../src/data/resource";
import { executeLoader } from "../src/data/routeLoader";
import { renderRoute } from "../src/platform/renderRoute";
import { hydrate } from "../src/platform/ssr";
import { renderToStringAsync } from "../src/platform/ssrAsync";
import { createRouter, destroyRouter, Route, routerReady } from "../src/plugins/router";
import { __resetTransfer } from "../src/utils/transfer";

const delay = <T>(ms: number, value: T): Promise<T> => new Promise((r) => setTimeout(() => r(value), ms));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetQueryCache();
  __resetTransfer();
  delete (window as unknown as Record<string, unknown>).__SIBU_TRANSFER__;
  destroyRouter();
  document.body.innerHTML = "";
});

/** Execute the transfer script as the browser would (it is an inline script). */
function runTransferScript(state: string): void {
  const body = /<script[^>]*>([\s\S]*)<\/script>/.exec(state)?.[1];
  if (body) new Function(body)();
  __resetTransfer();
}

describe("the transfer payload", () => {
  it("is one escaped, nonce-aware script that round-trips the data exactly", async () => {
    const tricky = {
      a: "</script><script>alert(1)</script>",
      b: "<!-- x -->",
      c: "line\u2028sep\u2029end",
      d: "&amp;",
    };
    const { state, stateData } = await renderToStringAsync(
      () => {
        const q = query("tricky", () => delay(1, tricky));
        return p(() => (q.data() ? "ok" : ""));
      },
      { nonce: "n0nce" },
    );
    expect(state.startsWith('<script nonce="n0nce">window.__SIBU_TRANSFER__=')).toBe(true);
    expect(state.match(/<\/script/gi)?.length).toBe(1);
    expect(state).not.toContain("<!--");
    expect(state).not.toMatch(/[\u2028\u2029]/);
    runTransferScript(state);
    const restored = (window as unknown as { __SIBU_TRANSFER__: { q: Record<string, { d: unknown }> } })
      .__SIBU_TRANSFER__;
    expect(restored.q.tricky.d).toEqual(tricky);
    expect(stateData).toMatchObject({ v: 1, q: { tricky: { d: tricky } } });
  });

  it("leaves out queries marked ssr: false", async () => {
    const { stateData } = await renderToStringAsync(() => {
      query("kept", () => delay(1, 1));
      query("private", () => delay(1, 2), { ssr: false });
      return p("x");
    });
    expect(stateData?.q).toHaveProperty("kept");
    expect(stateData?.q).not.toHaveProperty("private");
  });

  it("caps the payload, drops the largest entries first and names them in development", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { stateData, diagnostics } = await renderToStringAsync(
      () => {
        query("big", () => delay(1, "x".repeat(5000)));
        query("small", () => delay(1, "y"));
        return p("x");
      },
      { maxStateBytes: 1000 },
    );
    expect(stateData?.q).toHaveProperty("small");
    expect(stateData?.q).not.toHaveProperty("big");
    expect(diagnostics.droppedState).toEqual(["q:big"]);
    expect(diagnostics.largestState[0].key).toBe("q:big");
    expect(warn.mock.calls.some((c) => /left out: q:big.*Largest entries: q:big/.test(String(c[0])))).toBe(true);
  });

  it("never carries a prototype-polluting key in either direction", async () => {
    const { stateData } = await renderToStringAsync(() => {
      query("__proto__", () => delay(1, { polluted: true }));
      return p("x");
    });
    expect(stateData === null || !Object.hasOwn(stateData.q as object, "__proto__")).toBe(true);
    (window as unknown as Record<string, unknown>).__SIBU_TRANSFER__ = JSON.parse(
      '{"v":1,"q":{"__proto__":{"d":{"polluted":true}},"ok":{"d":1,"t":0}}}',
    );
    __resetTransfer();
    const q = query("ok", () => Promise.resolve(2), { staleTime: Number.POSITIVE_INFINITY });
    expect(q.data()).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ignores a payload with another layout version, or that is not a plain object", () => {
    (window as unknown as Record<string, unknown>).__SIBU_TRANSFER__ = { v: 999, q: { k: { d: 1 } } };
    __resetTransfer();
    const fetcher = vi.fn(() => Promise.resolve(2));
    query("k", fetcher);
    expect(fetcher).toHaveBeenCalled();
  });

  it("never mixes data from concurrent requests", async () => {
    const render = (user: string, ms: number) =>
      renderToStringAsync(() => {
        const q = query("profile", () => delay(ms, { user }));
        const r = resource(() => delay(ms, `${user}-r`), { key: "res" });
        return p(() => `${q.data()?.user ?? ""} ${r.data() ?? ""}`);
      });
    const results = await Promise.all([render("ana", 30), render("ben", 5), render("cy", 15)]);
    for (const [i, user] of ["ana", "ben", "cy"].entries()) {
      expect(results[i].html).toContain(`${user} ${user}-r`);
      expect(results[i].stateData).toMatchObject({ q: { profile: { d: { user } } }, r: { res: `${user}-r` } });
    }
  });
});

describe("restoring in the browser", () => {
  it("does not refetch fresh data, and the page renders it at once", async () => {
    const server = await renderToStringAsync(() => {
      const q = query("/api/items", () => delay(1, ["a", "b"]), { staleTime: 60_000 });
      return ul([
        each(
          () => q.data() ?? [],
          (v) => li(v()),
          { key: (v) => v },
        ),
      ]);
    });
    runTransferScript(server.state);
    const fetcher = vi.fn(() => Promise.resolve(["a", "b"]));
    const q = query("/api/items", fetcher, { staleTime: 60_000 });
    expect(q.data()).toEqual(["a", "b"]);
    expect(q.isStale()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refetches stale data in the background, keeping the rendered nodes when nothing changed", async () => {
    const server = await renderToStringAsync(() => {
      query("/api/stale", () => delay(1, [{ id: 1, n: "a" }]));
      return p("x");
    });
    runTransferScript(server.state);
    const fetcher = vi.fn(() => delay(1, [{ id: 1, n: "a" }]));
    const q = query("/api/stale", fetcher);
    const host = div([
      ul([
        each(
          () => q.data() ?? [],
          (row) => li(() => row().n),
          { key: (r) => r.id },
        ),
      ]),
    ]);
    document.body.appendChild(host);
    await Promise.resolve();
    const before = host.querySelector("li");
    expect(before?.textContent).toBe("a");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await delay(10, null);
    // Structural sharing: an identical refetch leaves the DOM untouched.
    expect(host.querySelector("li")).toBe(before);
  });

  it("starts a keyed resource and a route loader from the transferred value", async () => {
    const loader = vi.fn(async () => ({ title: "loaded" }));
    const server = await renderToStringAsync(() => {
      const r = resource(() => delay(1, "server value"), { key: "greeting" });
      const l = executeLoader(loader, { params: {}, path: "/x" });
      return p(() => `${r.data() ?? ""} ${l.data()?.title ?? ""}`);
    });
    expect(server.html).toContain("server value loaded");
    runTransferScript(server.state);
    loader.mockClear();
    const fetcher = vi.fn(() => Promise.resolve("client value"));
    const r = resource(fetcher, { key: "greeting" });
    const l = executeLoader(loader, { params: {}, path: "/x" });
    expect(r.data()).toBe("server value");
    expect(l.data()).toEqual({ title: "loaded" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("the fixture landing page", () => {
  it("renders the grid from /api/catalog on the server, and the browser does not request it again", async () => {
    // jsdom has no canvas: the cards' recolor step gets no context and skips drawing.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.stubGlobal("fetch", createStubFetch());
    const server = await renderRoute(routes, "/", { router: { head } });
    expect(server.html.match(/<article class="card"/g)?.length).toBe(3);
    runTransferScript(server.state);

    const browserFetch = createStubFetch();
    vi.stubGlobal("fetch", browserFetch);
    const root = document.createElement("div");
    document.body.appendChild(root);
    root.innerHTML = server.html;
    createRouter(routes, { mode: "memory", url: "/", head });
    await routerReady();
    // The replace strategy: a fresh client tree, fed from the transferred cache.
    hydrate(() => Route() as unknown as HTMLElement, root);
    await delay(20, null);
    expect(root.querySelectorAll("article.card").length).toBe(3);
    expect(browserFetch.calls).toEqual([]);
  });
});
