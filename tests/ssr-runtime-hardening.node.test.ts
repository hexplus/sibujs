// @vitest-environment node
//
// Server-runtime hardening: async renders refuse to run without request
// isolation, and request-controlled strings cannot make the server DOM's style
// parser or the router's trailing-slash trim quadratic.

import { afterEach, describe, expect, it, vi } from "vitest";
import { div } from "../src/core/rendering/html";
import { renderRoute } from "../src/platform/renderRoute";
import { renderToStringAsync } from "../src/platform/ssrAsync";
import type { RouteDef } from "../src/plugins/router";

const SSR_KEY = Symbol.for("sibujs.ssr.v1");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("async server rendering without AsyncLocalStorage", () => {
  it("is refused on a server runtime instead of sharing one store between requests", async () => {
    const g = globalThis as Record<symbol, unknown>;
    const saved = g[SSR_KEY];
    // A runtime where detection found no AsyncLocalStorage.
    g[SSR_KEY] = {
      als: null,
      fallbackStore: { ssr: false, suspenseIdCounter: 0, locale: undefined },
      fallbackDepth: 0,
    };
    vi.resetModules();
    try {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const ssr = await import("../src/platform/ssrAsync");
      const route = await import("../src/platform/renderRoute");
      const html = await import("../src/core/rendering/html");
      await expect(ssr.renderToStringAsync(() => html.p("x"))).rejects.toThrow(/needs AsyncLocalStorage/);
      await expect(route.renderRoute([{ path: "/", component: () => html.p("x") }], "/")).rejects.toThrow(
        /renderRoute\(\) needs AsyncLocalStorage/,
      );
    } finally {
      g[SSR_KEY] = saved;
      vi.resetModules();
    }
  });

  it("renders as usual where AsyncLocalStorage exists", async () => {
    const r = await renderToStringAsync(() => div("ok"));
    expect(r.html).toContain("ok");
  });
});

describe("request-controlled strings stay linear", () => {
  it("parses a style value with a long run of spaces quickly, !important included", async () => {
    const spaces = " ".repeat(40_000);
    const started = performance.now();
    const r = await renderToStringAsync(() =>
      div({ style: { color: `red${spaces}x` } }, [div({ style: "color: blue !important" })]),
    );
    // Quadratic backtracking took over a second here; linear is ~1 ms.
    expect(performance.now() - started).toBeLessThan(500);
    expect(r.html).toContain("color: blue !important");
  });

  it("trims a long run of slashes with trailingSlash: ignore quickly", async () => {
    const routes: RouteDef[] = [
      { path: "/a", component: () => div("a") },
      { path: "*", component: () => div("missing") },
    ];
    const started = performance.now();
    const r = await renderRoute(routes, `/a${"/".repeat(60_000)}x`, { router: { trailingSlash: "ignore" } });
    expect(performance.now() - started).toBeLessThan(500);
    expect(r.status).toBe(404);
    const ok = await renderRoute(routes, "/a///", { router: { trailingSlash: "ignore" } });
    expect(ok.status).toBe(200);
  });
});
