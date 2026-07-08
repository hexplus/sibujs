import { describe, expect, it } from "vitest";
import type { SSRRouteDef, SSRRouteState } from "../src/plugins/routerSSR";
import {
  createSSRRouter,
  deserializeRouteState,
  renderRouteToString,
  resolveServerRoute,
  serializeRouteState,
} from "../src/plugins/routerSSR";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoutes(): SSRRouteDef[] {
  return [
    {
      path: "/",
      name: "home",
      meta: { title: "Home" },
      component: () => {
        const el = document.createElement("div");
        el.textContent = "Home Page";
        return el;
      },
    },
    {
      path: "/about",
      name: "about",
      meta: { title: "About" },
      component: () => {
        const el = document.createElement("h1");
        el.textContent = "About Us";
        return el;
      },
    },
    {
      path: "/user/:id",
      name: "user",
      meta: { requiresAuth: true },
      component: () => {
        const el = document.createElement("span");
        el.textContent = "User Profile";
        return el;
      },
    },
    {
      path: "/user/:id/posts/:postId",
      name: "user-post",
      component: () => {
        const el = document.createElement("article");
        el.textContent = "Post Detail";
        return el;
      },
    },
    {
      path: "/files/*",
      name: "files",
      component: () => {
        const el = document.createElement("div");
        el.textContent = "File Browser";
        return el;
      },
    },
    {
      path: "/old-page",
      name: "old-page",
      redirect: "/about",
      component: () => document.createElement("div"),
    },
    {
      path: "/redirect-chain-a",
      redirect: "/redirect-chain-b",
      component: () => document.createElement("div"),
    },
    {
      path: "/redirect-chain-b",
      redirect: "/about",
      component: () => document.createElement("div"),
    },
  ];
}

// ===========================================================================
// resolveServerRoute
// ===========================================================================

describe("resolveServerRoute", () => {
  const routes = makeRoutes();

  it("should resolve a static root route", () => {
    const { route, component } = resolveServerRoute("/", routes);
    expect(route.path).toBe("/");
    expect(route.name).toBe("home");
    expect(route.params).toEqual({});
    expect(route.query).toEqual({});
    expect(route.hash).toBe("");
    expect(route.meta).toEqual({ title: "Home" });
    expect(component).not.toBeNull();
  });

  it("should resolve a static non-root route", () => {
    const { route, component } = resolveServerRoute("/about", routes);
    expect(route.path).toBe("/about");
    expect(route.name).toBe("about");
    expect(component).not.toBeNull();
  });

  it("should extract dynamic params", () => {
    const { route } = resolveServerRoute("/user/42", routes);
    expect(route.path).toBe("/user/42");
    expect(route.params).toEqual({ id: "42" });
    expect(route.name).toBe("user");
    expect(route.meta).toEqual({ requiresAuth: true });
  });

  it("should extract multiple dynamic params", () => {
    const { route } = resolveServerRoute("/user/7/posts/99", routes);
    expect(route.params).toEqual({ id: "7", postId: "99" });
    expect(route.name).toBe("user-post");
  });

  it("should parse query strings", () => {
    const { route } = resolveServerRoute("/about?foo=bar&baz=qux", routes);
    expect(route.path).toBe("/about");
    expect(route.query).toEqual({ foo: "bar", baz: "qux" });
  });

  it("should handle query param without value", () => {
    const { route } = resolveServerRoute("/about?flag", routes);
    expect(route.query).toEqual({ flag: "" });
  });

  it("should parse hash fragments", () => {
    const { route } = resolveServerRoute("/about#section-2", routes);
    expect(route.path).toBe("/about");
    expect(route.hash).toBe("section-2");
  });

  it("should parse query and hash together", () => {
    const { route } = resolveServerRoute("/user/5?tab=posts#recent", routes);
    expect(route.path).toBe("/user/5");
    expect(route.params).toEqual({ id: "5" });
    expect(route.query).toEqual({ tab: "posts" });
    expect(route.hash).toBe("recent");
  });

  it("should match wildcard catch-all routes", () => {
    const { route } = resolveServerRoute("/files/docs/readme.md", routes);
    expect(route.params).toEqual({ pathMatch: "docs/readme.md" });
    expect(route.name).toBe("files");
  });

  it("should not match wildcard route when trailing slash normalizes away the wildcard segment", () => {
    // "/files/" normalizes to "/files" which does not match the pattern "/files/*"
    // because the wildcard segment expects "/files/(.*)" with content after the slash.
    const { route, component } = resolveServerRoute("/files/", routes);
    expect(component).toBeNull();
    expect(route.path).toBe("/files");
  });

  it("should follow redirects", () => {
    const { route, component } = resolveServerRoute("/old-page", routes);
    // The redirect should have resolved to /about
    expect(route.path).toBe("/about");
    expect(route.name).toBe("about");
    expect(component).not.toBeNull();
  });

  it("should follow chained redirects", () => {
    const { route } = resolveServerRoute("/redirect-chain-a", routes);
    // /redirect-chain-a -> /redirect-chain-b -> /about
    expect(route.path).toBe("/about");
    expect(route.name).toBe("about");
  });

  it("should return null component for unmatched routes", () => {
    const { route, component } = resolveServerRoute("/nonexistent", routes);
    expect(component).toBeNull();
    expect(route.path).toBe("/nonexistent");
    expect(route.params).toEqual({});
  });

  it("should decode URI-encoded params", () => {
    const { route } = resolveServerRoute("/user/hello%20world", routes);
    expect(route.params).toEqual({ id: "hello world" });
  });

  it("should decode URI-encoded query values", () => {
    const { route } = resolveServerRoute("/about?name=John%20Doe", routes);
    expect(route.query).toEqual({ name: "John Doe" });
  });
});

// ===========================================================================
// renderRouteToString
// ===========================================================================

describe("renderRouteToString", () => {
  const routes = makeRoutes();

  it("should render a matched route component to an HTML string", () => {
    const { html, state } = renderRouteToString("/about", routes);
    expect(html).toContain("About Us");
    expect(html).toContain("<h1");
    expect(html).toContain("</h1>");
    expect(state.path).toBe("/about");
    expect(state.name).toBe("about");
  });

  it("should return empty HTML for unmatched routes", () => {
    const { html, state } = renderRouteToString("/nonexistent", routes);
    expect(html).toBe("");
    expect(state.path).toBe("/nonexistent");
  });

  it("should render root route", () => {
    const { html, state } = renderRouteToString("/", routes);
    expect(html).toContain("Home Page");
    expect(state.name).toBe("home");
  });

  it("should preserve route state for dynamic routes", () => {
    const { html, state } = renderRouteToString("/user/42?tab=settings#bio", routes);
    expect(html).toContain("User Profile");
    expect(state.params).toEqual({ id: "42" });
    expect(state.query).toEqual({ tab: "settings" });
    expect(state.hash).toBe("bio");
  });

  it("should follow redirects and render the target", () => {
    const { html, state } = renderRouteToString("/old-page", routes);
    expect(html).toContain("About Us");
    expect(state.path).toBe("/about");
  });
});

// ===========================================================================
// serializeRouteState / deserializeRouteState
// ===========================================================================

describe("serializeRouteState / deserializeRouteState", () => {
  it("should serialize state to a script tag string", () => {
    const state: SSRRouteState = {
      path: "/user/42",
      params: { id: "42" },
      query: { tab: "posts" },
      hash: "section",
      meta: { requiresAuth: true },
      name: "user",
    };
    const serialized = serializeRouteState(state);
    expect(serialized).toContain("<script>");
    expect(serialized).toContain("</script>");
    expect(serialized).toContain("__SIBU_ROUTE_STATE__");
  });

  it("should escape < and > in serialized output", () => {
    const state: SSRRouteState = {
      path: "/test",
      params: {},
      query: {},
      hash: "",
      meta: { html: "<script>alert('xss')</script>" },
    };
    const serialized = serializeRouteState(state);
    // The inner < and > should be escaped as unicode
    expect(serialized).not.toContain("<script>alert");
    expect(serialized).toContain("\\u003c");
    expect(serialized).toContain("\\u003e");
  });

  it("should round-trip through serialize then deserialize", () => {
    const state: SSRRouteState = {
      path: "/user/7",
      params: { id: "7" },
      query: { sort: "date" },
      hash: "top",
      meta: { title: "User 7" },
      name: "user",
    };

    const serialized = serializeRouteState(state);

    // Extract the JSON assignment and evaluate it onto window
    // The serialized format is: <script>window.__SIBU_ROUTE_STATE__={...}</script>
    const jsonMatch = serialized.match(/window\.__SIBU_ROUTE_STATE__=(.+)<\/script>/);
    expect(jsonMatch).not.toBeNull();

    // Unescape the unicode escapes and parse
    const rawJson = jsonMatch?.[1]
      .replace(/\\u003c/g, "<")
      .replace(/\\u003e/g, ">")
      .replace(/\\u0026/g, "&");

    (window as unknown as Record<string, unknown>).__SIBU_ROUTE_STATE__ = JSON.parse(rawJson);

    const deserialized = deserializeRouteState();
    expect(deserialized).toBeDefined();
    expect(deserialized?.path).toBe("/user/7");
    expect(deserialized?.params).toEqual({ id: "7" });
    expect(deserialized?.query).toEqual({ sort: "date" });
    expect(deserialized?.hash).toBe("top");
    expect(deserialized?.meta).toEqual({ title: "User 7" });
    expect(deserialized?.name).toBe("user");

    // Cleanup
    delete (window as unknown as Record<string, unknown>).__SIBU_ROUTE_STATE__;
  });

  it("should return undefined when no state is on window", () => {
    delete (window as unknown as Record<string, unknown>).__SIBU_ROUTE_STATE__;
    const result = deserializeRouteState();
    expect(result).toBeUndefined();
  });
});

// ===========================================================================
// createSSRRouter
// ===========================================================================

describe("createSSRRouter", () => {
  const routes = makeRoutes();

  it("should return an object with resolve, renderToString, and renderToDocument", () => {
    const router = createSSRRouter(routes);
    expect(typeof router.resolve).toBe("function");
    expect(typeof router.renderToString).toBe("function");
    expect(typeof router.renderToDocument).toBe("function");
  });

  it("resolve should behave like resolveServerRoute", () => {
    const router = createSSRRouter(routes);
    const { route, component } = router.resolve("/user/10?page=2#top");
    expect(route.path).toBe("/user/10");
    expect(route.params).toEqual({ id: "10" });
    expect(route.query).toEqual({ page: "2" });
    expect(route.hash).toBe("top");
    expect(component).not.toBeNull();
  });

  it("renderToString should return html and state", () => {
    const router = createSSRRouter(routes);
    const { html, state } = router.renderToString("/about");
    expect(html).toContain("About Us");
    expect(state.path).toBe("/about");
    expect(state.name).toBe("about");
  });

  it("renderToDocument should return a full HTML document", () => {
    const router = createSSRRouter(routes);
    const doc = router.renderToDocument("/about", {
      title: "About Page",
      scripts: ["/app.js"],
    });
    expect(doc).toContain("<!DOCTYPE html>");
    expect(doc).toContain("<title>About Page</title>");
    expect(doc).toContain("About Us");
    expect(doc).toContain("__SIBU_ROUTE_STATE__");
    expect(doc).toContain('/app.js"');
    expect(doc).toContain('<div id="app">');
  });

  it("renderToDocument should include meta and link tags", () => {
    const router = createSSRRouter(routes);
    const doc = router.renderToDocument("/", {
      title: "Home",
      meta: [{ name: "description", content: "Welcome home" }],
      links: [{ rel: "stylesheet", href: "/style.css" }],
    });
    expect(doc).toContain('name="description"');
    expect(doc).toContain('content="Welcome home"');
    expect(doc).toContain('rel="stylesheet"');
    expect(doc).toContain('href="/style.css"');
  });

  it("resolve should return null component for unmatched routes", () => {
    const router = createSSRRouter(routes);
    const { component } = router.resolve("/does-not-exist");
    expect(component).toBeNull();
  });

  it("resolve should follow redirects", () => {
    const router = createSSRRouter(routes);
    const { route } = router.resolve("/old-page");
    expect(route.path).toBe("/about");
    expect(route.name).toBe("about");
  });
});
