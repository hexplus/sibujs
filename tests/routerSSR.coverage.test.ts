import { afterEach, describe, expect, it } from "vitest";
import { destroyRouter, route } from "../src/plugins/router";
import type { SSRRouteDef } from "../src/plugins/routerSSR";
import {
  createSSRRouter,
  deserializeRouteState,
  hydrateRouter,
  renderRouteToString,
  resolveServerRoute,
  serializeRouteState,
} from "../src/plugins/routerSSR";

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function comp(label: string): () => HTMLElement {
  return () => {
    const el = document.createElement("div");
    el.textContent = label;
    return el;
  };
}

function routes(): SSRRouteDef[] {
  return [
    { path: "/", name: "home", meta: { title: "Home" }, component: comp("Home") },
    { path: "/about", name: "about", component: comp("About") },
    { path: "/user/:id", name: "user", component: comp("User") },
    { path: "/user/:id?", name: "user-opt", component: comp("UserOpt") },
    { path: "/files/:path*", name: "named-wild", component: comp("NamedWild") },
    { path: "/glob/*", name: "glob", component: comp("Glob") },
  ];
}

afterEach(() => {
  try {
    destroyRouter();
  } catch {}
  delete (window as unknown as Record<string, unknown>).__SIBU_ROUTE_STATE__;
});

// ===========================================================================
// parseURL edge cases
// ===========================================================================

describe("parseURL / matching edge cases", () => {
  it("survives malformed percent-encoded path params", () => {
    const { route: r } = resolveServerRoute("/user/%E0%A4%A", routes());
    // Falls back to raw on bad decode
    expect(r.params.id).toBe("%E0%A4%A");
  });

  it("survives malformed percent-encoded query keys/values", () => {
    const { route: r } = resolveServerRoute("/about?%E0%A4%A=%E0%A4%A", routes());
    expect(r.query["%E0%A4%A"]).toBe("%E0%A4%A");
  });

  it("ignores empty query pairs", () => {
    const { route: r } = resolveServerRoute("/about?&a=1&", routes());
    expect(r.query).toEqual({ a: "1" });
  });

  it("blocks prototype-pollution query keys", () => {
    const { route: r } = resolveServerRoute("/about?__proto__=evil&constructor=x&prototype=y&ok=1", routes());
    expect(r.query.ok).toBe("1");
    expect(Object.hasOwn(r.query, "__proto__")).toBe(false);
    expect((r.query as Record<string, string>).constructor).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).evil).toBeUndefined();
  });

  it("blocks prototype-pollution param keys", () => {
    const r = createSSRRouter([{ path: "/x/:__proto__", component: comp("X") }]);
    const { route: state } = r.resolve("/x/evil");
    expect((Object.prototype as Record<string, unknown>).evil).toBeUndefined();
    expect(Object.hasOwn(state.params, "__proto__")).toBe(false);
  });

  it("matches optional param with the segment present", () => {
    const { route: r, component } = resolveServerRoute("/user/9", routes());
    expect(component).not.toBeNull();
    expect(r.params.id).toBe("9");
  });

  it("matches a named wildcard catch-all", () => {
    const { route: r } = resolveServerRoute("/files/a/b/c.txt", routes());
    expect(r.params.path).toBe("a/b/c.txt");
    expect(r.name).toBe("named-wild");
  });

  it("matches a plain wildcard catch-all", () => {
    const { route: r } = resolveServerRoute("/glob/deep/path", routes());
    expect(r.params.pathMatch).toBe("deep/path");
  });

  it("normalizes repeated slashes and trailing slash", () => {
    const { route: r } = resolveServerRoute("//about//", routes());
    expect(r.path).toBe("/about");
    expect(r.name).toBe("about");
  });
});

// ===========================================================================
// Redirect handling
// ===========================================================================

describe("SSR redirect handling", () => {
  it("warns on absolute-URL redirect but still follows", () => {
    const defs: SSRRouteDef[] = [
      { path: "/ext", redirect: "https://example.com/landing", component: comp("Ext") },
      { path: "https:/", component: comp("Fallthrough") },
    ];
    const { redirect } = resolveServerRoute("/ext", defs);
    // It attempts to follow the absolute redirect (no match -> null component).
    expect(redirect).toBeUndefined();
  });

  it("stops following after MAX_REDIRECT_DEPTH and returns the redirect", () => {
    // Self-referential redirect loop.
    const defs: SSRRouteDef[] = [{ path: "/loop", redirect: "/loop", component: comp("Loop") }];
    const { route: r, component, redirect } = resolveServerRoute("/loop", defs);
    expect(component).toBeNull();
    expect(redirect).toBe("/loop");
    expect(r.path).toBe("/loop");
  });

  it("follows protocol-relative redirect with a warning", () => {
    const defs: SSRRouteDef[] = [{ path: "/pr", redirect: "//cdn.example.com", component: comp("Pr") }];
    const { component } = resolveServerRoute("/pr", defs);
    // No matching route for the absolute target -> null component.
    expect(component).toBeNull();
  });
});

// ===========================================================================
// serializeRouteState with nonce
// ===========================================================================

describe("serializeRouteState nonce + escaping", () => {
  it("adds a nonce attribute when provided", () => {
    const serialized = serializeRouteState({ path: "/", params: {}, query: {}, hash: "", meta: {} }, "abc123");
    expect(serialized).toContain('nonce="abc123"');
  });

  it("escapes the ampersand in serialized output", () => {
    const serialized = serializeRouteState({
      path: "/x",
      params: {},
      query: { a: "1&2" },
      hash: "",
      meta: {},
    });
    expect(serialized).toContain("\\u0026");
  });
});

// ===========================================================================
// renderRouteToDocument: attribute sanitization
// ===========================================================================

describe("renderRouteToDocument sanitization", () => {
  const r = createSSRRouter(routes());

  it("escapes the title", () => {
    const doc = r.renderToDocument("/", { title: "<script>x</script>" });
    expect(doc).not.toContain("<script>x</script>");
    expect(doc).toContain("&lt;script&gt;");
  });

  it("drops event-handler attributes on meta/link tags", () => {
    const doc = r.renderToDocument("/", {
      meta: [{ name: "description", onload: "evil()", content: "ok" }],
    });
    expect(doc).not.toContain("onload");
    expect(doc).toContain('name="description"');
    expect(doc).toContain('content="ok"');
  });

  it("drops invalid attribute names", () => {
    const doc = r.renderToDocument("/", {
      meta: [{ "bad name!": "x", name: "valid" }],
    });
    expect(doc).not.toContain("bad name!");
    expect(doc).toContain('name="valid"');
  });

  it("sanitizes unsafe URL attribute values on links", () => {
    const doc = r.renderToDocument("/", {
      links: [{ rel: "stylesheet", href: "javascript:evil()" }],
    });
    // unsafe href dropped -> the link tag keeps only rel
    expect(doc).not.toContain("javascript:evil");
  });

  it("drops unsafe script src and keeps safe ones", () => {
    const doc = r.renderToDocument("/", {
      scripts: ["javascript:bad()", "/safe.js"],
    });
    expect(doc).not.toContain("javascript:bad");
    expect(doc).toContain('src="/safe.js"');
  });

  it("renders an empty meta tag string when all attrs are dropped", () => {
    const doc = r.renderToDocument("/", {
      meta: [{ onerror: "x" }],
    });
    // no <meta with onerror, document still valid
    expect(doc).toContain("<!DOCTYPE html>");
    expect(doc).not.toContain("onerror");
  });

  it("includes a nonce on the state script when provided", () => {
    const doc = r.renderToDocument("/", { nonce: "n-1" });
    expect(doc).toContain('nonce="n-1"');
  });
});

// ===========================================================================
// renderRouteToString unmatched
// ===========================================================================

describe("renderRouteToString unmatched", () => {
  it("returns empty html and the requested path when no route matches", () => {
    const { html, state } = renderRouteToString("/does-not-exist", routes());
    expect(html).toBe("");
    expect(state.path).toBe("/does-not-exist");
    expect(state.params).toEqual({});
  });
});

// ===========================================================================
// hydrateRouter
// ===========================================================================

describe("hydrateRouter", () => {
  it("falls back to a normal client router when no server state exists", async () => {
    window.history.replaceState({}, "", "/about");
    delete (window as unknown as Record<string, unknown>).__SIBU_ROUTE_STATE__;
    hydrateRouter(routes() as unknown as SSRRouteDef[]);
    await wait();
    // A global router is created; route() should not throw.
    expect(() => route()).not.toThrow();
  });

  it("hydrates an existing container using server state", async () => {
    const container = document.createElement("div");
    container.id = "app";
    container.innerHTML = "<div>About</div>";
    document.body.appendChild(container);

    (window as unknown as Record<string, unknown>).__SIBU_ROUTE_STATE__ = {
      path: "/about",
      params: {},
      query: {},
      hash: "",
      meta: {},
      name: "about",
    };

    hydrateRouter(routes() as unknown as SSRRouteDef[], { container });
    await wait(150);
    expect(deserializeRouteState()?.path).toBe("/about");
    expect(() => route()).not.toThrow();

    document.body.removeChild(container);
  });

  it("hydrates with server state but no matching component (no crash)", async () => {
    (window as unknown as Record<string, unknown>).__SIBU_ROUTE_STATE__ = {
      path: "/unmatched-path",
      params: {},
      query: {},
      hash: "",
      meta: {},
    };
    const container = document.createElement("div");
    container.id = "app2";
    document.body.appendChild(container);
    hydrateRouter(routes() as unknown as SSRRouteDef[], { container });
    await wait(100);
    expect(() => route()).not.toThrow();
    document.body.removeChild(container);
  });
});
