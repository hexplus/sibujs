// @vitest-environment node
/**
 * P0 — SSR under a genuine Node environment, with NO browser globals.
 *
 * The rest of the suite runs under jsdom, which silently provides `document`,
 * `window`, and friends. That masks the question a real server deployment asks:
 * what actually works in `node` without a DOM shim?
 *
 * These tests establish that boundary as *evidence*, not assumption. Where a
 * capability genuinely requires a DOM, that is recorded as a documented design
 * characteristic rather than treated as a bug.
 */
import { describe, expect, it } from "vitest";

describe("SSR in a bare Node environment", () => {
  it("confirms no browser globals are present", () => {
    expect(typeof document).toBe("undefined");
    expect(typeof window).toBe("undefined");
    expect(typeof HTMLElement).toBe("undefined");
  });

  it("imports the SSR module without touching browser globals at load time", async () => {
    // A module that reached for `document` at import time would throw here.
    const mod = await import("../src/platform/ssr");
    expect(typeof mod.renderToString).toBe("function");
    expect(typeof mod.serializeState).toBe("function");
    expect(typeof mod.escapeScriptJson).toBe("function");
  });

  it("imports the SSR context module and reports non-SSR by default", async () => {
    const { isSSR, runInSSRContext } = await import("../src/core/ssr-context");
    expect(isSSR()).toBe(false);
    const inside = runInSSRContext(() => isSSR());
    expect(inside).toBe(true);
    expect(isSSR()).toBe(false);
  });

  it("provides real AsyncLocalStorage-backed isolation on Node", async () => {
    const { getSSRStore, runInSSRContext } = await import("../src/core/ssr-context");

    const a = runInSSRContext(async () => {
      getSSRStore().suspenseIdCounter = 7;
      await new Promise((r) => setTimeout(r, 5));
      return getSSRStore().suspenseIdCounter;
    });
    const b = runInSSRContext(async () => {
      getSSRStore().suspenseIdCounter = 99;
      await new Promise((r) => setTimeout(r, 1));
      return getSSRStore().suspenseIdCounter;
    });

    // If ALS were unavailable this would collapse to a shared global and both
    // would report the same value.
    expect(await Promise.all([a, b])).toEqual([7, 99]);
  });

  it("serializes state without a DOM", async () => {
    const { serializeState } = await import("../src/platform/ssr");
    const html = serializeState({ user: "Alice", xss: "</script><script>alert(1)</script>" });

    expect(html).toContain("<script>");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("\\u003c");
  });

  it("escapes script JSON without a DOM", async () => {
    const { escapeScriptJson } = await import("../src/platform/ssr");
    const out = escapeScriptJson('{"a":"</script>"}');
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });

  it("deserializeState returns undefined off-browser instead of throwing", async () => {
    const { deserializeState } = await import("../src/platform/ssr");
    expect(deserializeState()).toBeUndefined();
  });

  it("resolves server routes without a DOM", async () => {
    const { resolveServerRoute } = await import("../src/plugins/routerSSR");

    const routes = [
      { path: "/", component: () => ({}) as never },
      { path: "/users", component: () => ({}) as never },
      { path: "/users/:id", component: () => ({}) as never },
    ];

    const result = resolveServerRoute("/users/42", routes as never);
    expect(result.route.path).toBe("/users/42");
    expect(result.route.params.id).toBe("42");
    expect(result.component).not.toBeNull();
  });

  it("parses query and hash without a DOM", async () => {
    const { resolveServerRoute } = await import("../src/plugins/routerSSR");
    const routes = [{ path: "/search", component: () => ({}) as never }];

    const result = resolveServerRoute("/search?q=sibujs&page=2#results", routes as never);
    expect(result.route.query.q).toBe("sibujs");
    expect(result.route.query.page).toBe("2");
    expect(result.route.hash).toBe("results");
  });

  it("returns a null component for an unmatched route without a DOM", async () => {
    const { resolveServerRoute } = await import("../src/plugins/routerSSR");
    const routes = [{ path: "/", component: () => ({}) as never }];

    const result = resolveServerRoute("/nope", routes as never);
    expect(result.component).toBeNull();
    expect(result.route.path).toBe("/nope");
  });

  it("terminates a server-side redirect loop without a DOM", async () => {
    const { resolveServerRoute } = await import("../src/plugins/routerSSR");
    const routes = [
      { path: "/a", redirect: "/b", component: () => ({}) as never },
      { path: "/b", redirect: "/a", component: () => ({}) as never },
    ];

    // Must terminate rather than recurse forever.
    expect(() => resolveServerRoute("/a", routes as never)).not.toThrow();
  });

  /**
   * DOCUMENTED DESIGN CHARACTERISTIC, not a bug.
   *
   * `renderToString(element)` takes a real DOM node and serialises it, so
   * building the tree requires `document`. SibuJS SSR therefore needs a DOM
   * implementation on the server (jsdom, happy-dom, linkedom) — unlike
   * frameworks that render straight to a string. This test pins that contract
   * so a future change either preserves it or updates the docs deliberately.
   */
  it("requires a DOM implementation to build a renderable tree", async () => {
    const { div } = await import("../src/core/rendering/html");

    // Constructing an element is what needs `document`, not renderToString.
    expect(() => div("hello")).toThrow();
  });
});
