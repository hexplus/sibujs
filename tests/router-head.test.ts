import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { div } from "../src/core/rendering/html";
import { mount } from "../src/core/rendering/mount";
import { signal } from "../src/core/signals/signal";
import { Head } from "../src/platform/head";
import { resolveRouteHead, routeHeadToHTML } from "../src/plugins/routeHead";
import {
  createRouter,
  destroyRouter,
  navigate,
  Outlet,
  Route,
  type RouteDef,
  routerReady,
} from "../src/plugins/router";

// ---------------------------------------------------------------------------
// Per-route <head>: the router keeps document.title and the description /
// canonical / Open Graph tags in step with the committed route.
// ---------------------------------------------------------------------------

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
};

const meta = (sel: string) => document.head.querySelector(sel)?.getAttribute("content") ?? null;
const desc = () => meta('meta[name="description"]');
const og = (p: string) => meta(`meta[property="og:${p}"]`);
const canonical = () => document.head.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null;

let unmount: (() => void) | undefined;

beforeEach(() => {
  document.head.innerHTML = "<title>Template</title>";
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  destroyRouter();
  document.head.innerHTML = "";
});

const Home = () => div("home");
const Quote = () => div("quote");
const Plain = () => div("plain");

function start(routes: RouteDef[], head?: Parameters<typeof createRouter>[1] extends infer O ? O : never) {
  createRouter(routes, { mode: "history", ...(head as object) });
  unmount = mount(() => div([Route()]), document.body).unmount;
}

describe("route head", () => {
  const routes: RouteDef[] = [
    {
      path: "/",
      component: Home,
      head: {
        title: "Home",
        description: "Custom wraps",
        canonical: "https://example.com/",
        og: { image: "https://example.com/og/home.png" },
      },
    },
    {
      path: "/cotizar",
      component: Quote,
      head: { title: "Get a quote", description: "Ask for a price", og: { type: "website" } },
    },
    { path: "/plain", component: Plain },
  ];

  it("applies the initial route's head and follows navigation, removing tags the next route does not set", async () => {
    start(routes);
    await settle();
    expect(document.title).toBe("Home");
    expect(desc()).toBe("Custom wraps");
    expect(canonical()).toBe("https://example.com/");
    expect(og("title")).toBe("Home");
    expect(og("description")).toBe("Custom wraps");
    expect(og("url")).toBe("https://example.com/");
    expect(og("image")).toBe("https://example.com/og/home.png");

    await navigate("/cotizar");
    await settle();
    expect(document.title).toBe("Get a quote");
    expect(desc()).toBe("Ask for a price");
    expect(canonical()).toBeNull();
    expect(og("image")).toBeNull();
    expect(og("type")).toBe("website");
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);

    await navigate("/plain");
    await settle();
    expect(document.title).toBe("Template");
    expect(desc()).toBeNull();
    expect(document.head.querySelectorAll("[data-sibu-head]")).toHaveLength(0);
  });

  it("restores the head when going back", async () => {
    start(routes);
    await settle();
    await navigate("/cotizar");
    await settle();
    history.back();
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    expect(location.pathname).toBe("/");
    expect(document.title).toBe("Home");
    expect(desc()).toBe("Custom wraps");
  });

  it("evaluates getters against the route and re-evaluates them reactively", async () => {
    const [lang, setLang] = signal("en");
    start([
      { path: "/", component: Home },
      {
        path: "/orders/:id",
        component: Plain,
        head: {
          title: (r) => (lang() === "en" ? `Order ${r.params.id}` : `Pedido ${r.params.id}`),
          description: () => (lang() === "en" ? "Your order" : "Tu pedido"),
        },
      },
    ]);
    await settle();
    await navigate("/orders/42");
    await settle();
    expect(document.title).toBe("Order 42");
    setLang("es");
    expect(document.title).toBe("Pedido 42");
    expect(desc()).toBe("Tu pedido");
  });

  it("merges router defaults, parent and child records, deepest winning; applies titleTemplate", async () => {
    createRouter(
      [
        {
          path: "/shop",
          component: () => div([Outlet()]),
          head: { description: "Shop", og: { siteName: "Wraps" } },
          children: [{ path: "/item", component: Plain, head: { title: "Item", og: { siteName: null } } }],
        },
        { path: "/", component: Home },
      ],
      { mode: "history", head: { title: "Wraps", titleTemplate: "%s · Wraps", og: { type: "website" } } },
    );
    unmount = mount(() => div([Route()]), document.body).unmount;
    await settle();
    // Only the defaults apply on "/"; the template is not applied to the default title.
    expect(document.title).toBe("Wraps");
    expect(og("type")).toBe("website");

    await navigate("/shop/item");
    await settle();
    expect(document.title).toBe("Item · Wraps");
    expect(desc()).toBe("Shop");
    expect(og("site_name")).toBeNull();
    expect(og("type")).toBe("website");
    expect(og("title")).toBe("Item");
  });

  it("supports extra meta entries such as robots", async () => {
    start([{ path: "/", component: Home, head: { meta: [{ name: "robots", content: "noindex" }] } }]);
    await settle();
    expect(meta('meta[name="robots"]')).toBe("noindex");
  });

  it("applies the head policy: unsafe URLs are omitted", async () => {
    start([
      {
        path: "/",
        component: Home,
        head: { canonical: "javascript:alert(1)", og: { image: "javascript:alert(1)", url: "data:text/html,x" } },
      },
    ]);
    await settle();
    expect(canonical()).toBeNull();
    expect(og("image")).toBeNull();
    expect(og("url")).toBeNull();
  });

  it("never touches the head when no route declares one", async () => {
    document.head.innerHTML = '<title>Mine</title><meta name="description" content="static">';
    start([{ path: "/", component: Home }]);
    await settle();
    expect(document.title).toBe("Mine");
    expect(desc()).toBe("static");
  });

  it("replaces the template's tags for the keys it manages instead of duplicating them", async () => {
    document.head.innerHTML =
      '<title>Tpl</title><meta name="description" content="template"><meta property="og:image" content="/x.png">';
    start(routes);
    await settle();
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(desc()).toBe("Custom wraps");
    expect(document.head.querySelectorAll('meta[property="og:image"]')).toHaveLength(1);
  });

  it("adopts pre-rendered tags and restores the template title for a route without one", async () => {
    document.head.innerHTML =
      '<title data-sibu-base-title="Template">Get a quote</title>' +
      '<meta name="description" content="Ask for a price" data-sibu-head="">' +
      '<meta property="og:type" content="website" data-sibu-head="">' +
      '<meta property="og:stale" content="x" data-sibu-head="">';
    history.replaceState(null, "", "/cotizar");
    start(routes);
    await settle();
    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.head.querySelector('meta[property="og:stale"]')).toBeNull();
    expect(document.title).toBe("Get a quote");
    await navigate("/plain");
    await settle();
    expect(document.title).toBe("Template");
  });

  it("a component's Head() title layers on top of the route title", async () => {
    start([
      { path: "/", component: () => div([Head({ title: "Modal open" }), "home"]), head: { title: "Home" } },
      { path: "/plain", component: Plain, head: { title: "Plain" } },
    ]);
    await settle();
    expect(document.title).toBe("Modal open");
    await navigate("/plain");
    await settle();
    expect(document.title).toBe("Plain");
  });

  it("gives everything back when the router is destroyed", async () => {
    start(routes);
    await settle();
    destroyRouter();
    expect(document.title).toBe("Template");
    expect(document.head.querySelectorAll("[data-sibu-head]")).toHaveLength(0);
  });
});

describe("routerReady()", () => {
  it("resolves after the initial route committed and its lazy component loaded", async () => {
    let loaded = false;
    createRouter(
      [
        {
          path: "/",
          lazy: async () => {
            await new Promise((r) => setTimeout(r, 20));
            loaded = true;
            return { default: Home };
          },
        },
      ],
      { mode: "history" },
    );
    await routerReady();
    expect(loaded).toBe(true);
  });

  it("resolves when the lazy component fails, and the outlet still reports the original error", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      createRouter([{ path: "/", lazy: () => Promise.reject(new Error("chunk 404")) }], { mode: "history" });
      await expect(routerReady()).resolves.toBeUndefined();
      unmount = mount(() => div([Route()]), document.body).unmount;
      await settle();
      expect(document.body.textContent).toContain("chunk 404");
      expect(document.body.textContent).not.toContain("failed recently");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("resolveRouteHead / routeHeadToHTML", () => {
  it("serializes escaped, marked tags", () => {
    const head = resolveRouteHead({
      path: "/",
      params: {},
      query: {},
      queryAll: {},
      hash: "",
      meta: {},
      matched: [{ path: "/", component: Home, head: { title: "A <b> & c", description: 'say "hi"' } }],
    });
    const html = routeHeadToHTML(head);
    expect(html).toContain("<title>A &lt;b&gt; &amp; c</title>");
    expect(html).toContain('content="say &quot;hi&quot;"');
    expect(html).toContain('data-sibu-head=""');
  });
});
