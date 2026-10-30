import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStubFetch } from "../fixtures/ssr-app/src/api";
import { head as fixtureHead, routes as fixtureRoutes } from "../fixtures/ssr-app/src/routes";
import { div, p } from "../src/core/rendering/html";
import { __resetQueryCache } from "../src/data/query";
import { Head } from "../src/platform/head";
import { renderRoute } from "../src/platform/renderRoute";
import { jsonLdScript, serializeJsonLd } from "../src/plugins/routeHead";
import { createRouter, destroyRouter, navigate, type RouteDef, routerReady } from "../src/plugins/router";

beforeEach(() => {
  vi.stubGlobal("fetch", createStubFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetQueryCache();
  destroyRouter();
  for (const el of Array.from(document.head.querySelectorAll("[data-sibu-head]"))) el.remove();
});

const page = () => div("page");

describe("route head on the server", () => {
  it("renders robots, twitter (with fallbacks), hreflang alternates and JSON-LD", async () => {
    const routes: RouteDef[] = [
      {
        path: "/",
        component: page,
        head: {
          title: "Home",
          description: "Welcome",
          robots: "index, follow",
          og: { image: "https://x.test/og.png" },
          twitter: { card: "summary_large_image", site: "@sibu" },
          alternates: [
            { hreflang: "es", href: "https://x.test/es" },
            { hreflang: "x-default", href: "https://x.test/" },
          ],
          jsonLd: { "@context": "https://schema.org", "@type": "Organization", name: "Sibu" },
        },
      },
    ];
    const { head } = await renderRoute(routes, "/");
    expect(head).toContain('<meta name="robots" content="index, follow" data-sibu-head="" />');
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image" data-sibu-head="" />');
    expect(head).toContain('<meta name="twitter:site" content="@sibu" data-sibu-head="" />');
    expect(head).toContain('<meta name="twitter:title" content="Home" data-sibu-head="" />');
    expect(head).toContain('<meta name="twitter:description" content="Welcome" data-sibu-head="" />');
    expect(head).toContain('<meta name="twitter:image" content="https://x.test/og.png" data-sibu-head="" />');
    expect(head).toContain('<link rel="alternate" hreflang="es" href="https://x.test/es" data-sibu-head="" />');
    expect(head).toContain('<link rel="alternate" hreflang="x-default" href="https://x.test/" data-sibu-head="" />');
    expect(head).toContain(
      '<script type="application/ld+json" data-sibu-ld="0" data-sibu-head="">{"@context":"https://schema.org","@type":"Organization","name":"Sibu"}</script>',
    );
  });

  it("applies the head policy to every new field (escaping, URL allowlist, no refresh)", async () => {
    const routes: RouteDef[] = [
      {
        path: "/",
        component: page,
        head: {
          title: "</title><script>alert(1)</script>",
          canonical: "javascript:alert(1)",
          og: { image: "javascript:alert(2)", url: "data:text/html,x" },
          twitter: { card: "summary", image: "javascript:alert(3)" },
          alternates: [{ hreflang: "en", href: "javascript:alert(4)" }],
          meta: [{ "http-equiv": "refresh", content: "0;url=javascript:alert(5)" }],
          jsonLd: { name: "</script><script>alert(6)</script>", note: "line\u2028break\u2029end" },
        },
      },
    ];
    const { head } = await renderRoute(routes, "/");
    expect(head).toContain("<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>");
    expect(head).not.toMatch(/javascript:|data:text/);
    expect(head).not.toContain("refresh");
    expect(head).not.toContain('rel="canonical"');
    expect(head).not.toContain('hreflang="en"');
    // The only `</script` is the element's own end tag.
    expect(head.match(/<\/script/g)?.length).toBe(1);
    expect(head).toContain("\\u003c/script\\u003e");
    expect(head).toContain("line\\u2028break\\u2029end");
    expect(head).not.toMatch(/[\u2028\u2029]/);
  });

  it("serializeJsonLd / jsonLdScript escape for a script body", () => {
    const text = serializeJsonLd({ a: "<!-- & -->", b: "\u2028" });
    expect(JSON.parse(text)).toEqual({ a: "<!-- & -->", b: "\u2028" });
    expect(text).not.toMatch(/[<>&\u2028]/);
    expect(jsonLdScript([{ "@type": "Thing" }])).toBe(
      '<script type="application/ld+json">[{"@type":"Thing"}]</script>',
    );
  });
});

describe("Head() inside the tree during a server render", () => {
  it("is collected into result.head; the innermost entry wins its key, once", async () => {
    const routes: RouteDef[] = [
      {
        path: "/",
        component: () =>
          div([
            Head({ title: "From component", meta: [{ name: "description", content: () => "Component description" }] }),
            p("body"),
          ]),
        head: { title: "From route", description: "Route description" },
      },
    ];
    const { head, html } = await renderRoute(routes, "/");
    expect(head).toContain("<title>From component</title>");
    expect(head).not.toContain("<title>From route</title>");
    expect(head.match(/name="description"/g)?.length).toBe(1);
    expect(head).toContain('content="Component description"');
    // Nothing was written into the (shared) document head.
    expect(document.head.innerHTML).not.toContain("Component description");
    expect(html).toContain("<!--sibu-head-->");
  });

  it("applies the head policy to Head() entries on the server", async () => {
    const routes: RouteDef[] = [
      {
        path: "/",
        component: () =>
          div([
            Head({
              meta: [
                { "http-equiv": "refresh", content: "0;url=javascript:alert(1)" },
                { name: "x", content: '"><script>' },
              ],
              link: [{ rel: "canonical", href: "javascript:alert(2)" }],
            }),
          ]),
      },
    ];
    const { head } = await renderRoute(routes, "/");
    expect(head).not.toContain("refresh");
    expect(head).not.toContain("javascript:");
    expect(head).toContain('content="&quot;&gt;&lt;script&gt;"');
  });
});

describe("route head in the browser", () => {
  it("updates on navigation, removes what the next route does not set, and restores on the way back", async () => {
    const routes: RouteDef[] = [
      {
        path: "/a",
        component: page,
        head: {
          title: "A",
          twitter: { card: "summary" },
          alternates: [{ hreflang: "es", href: "https://x.test/es/a" }],
          jsonLd: { "@type": "Product", name: "A" },
        },
      },
      { path: "/b", component: page, head: { title: "B", robots: "noindex" } },
    ];
    createRouter(routes, { mode: "memory", url: "/a" });
    await routerReady();
    const q = (sel: string) => document.head.querySelector(sel);
    expect(document.title).toBe("A");
    expect(q('meta[name="twitter:card"]')?.getAttribute("content")).toBe("summary");
    expect(q('link[hreflang="es"]')?.getAttribute("href")).toBe("https://x.test/es/a");
    expect(q('script[type="application/ld+json"][data-sibu-head]')?.textContent).toBe('{"@type":"Product","name":"A"}');

    await navigate("/b");
    expect(document.title).toBe("B");
    expect(q('meta[name="robots"]')?.getAttribute("content")).toBe("noindex");
    expect(q('meta[name="twitter:card"]')).toBeNull();
    expect(q('link[hreflang="es"]')).toBeNull();
    expect(q('script[type="application/ld+json"][data-sibu-head]')).toBeNull();

    await navigate("/a");
    expect(document.title).toBe("A");
    expect(q('meta[name="robots"]')).toBeNull();
    expect(q('script[type="application/ld+json"][data-sibu-head]')?.textContent).toBe('{"@type":"Product","name":"A"}');
  });
});

describe("link previews: every fixture route serves its own title, description and Open Graph tags", () => {
  /** What a link-preview bot reads: the <title> and the og:* / description meta tags. */
  function preview(headHtml: string) {
    const meta = (key: string, attr = "property") =>
      new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(headHtml)?.[1] ?? null;
    return {
      title: /<title>([^<]*)<\/title>/.exec(headHtml)?.[1] ?? null,
      description: meta("description", "name"),
      ogTitle: meta("og:title"),
      ogDescription: meta("og:description"),
      ogImage: meta("og:image"),
      ogSiteName: meta("og:site_name"),
    };
  }

  const urls = [
    "/",
    "/producto/taza",
    "/cotizar?servicio=dtf",
    "/galeria",
    "/ayuda/envios",
    "/estado",
    "/disenador",
    "/admin",
    "/no-existe",
  ];

  it.each(urls)("%s", async (url) => {
    const r = await renderRoute(fixtureRoutes, url, { router: { head: fixtureHead } });
    const card = preview(r.head);
    expect(card.title).toMatch(/· Estampados Sibu$/);
    expect(card.ogTitle).toBeTruthy();
    expect(card.title?.startsWith(card.ogTitle as string)).toBe(true);
    expect(card.description).toBeTruthy();
    expect(card.ogDescription).toBe(card.description);
    expect(card.ogImage).toMatch(/^https:\/\/fixture\.test\/og\//);
    expect(card.ogSiteName).toBe("Estampados Sibu");
  });

  it("gives each route a distinct title", async () => {
    const titles = await Promise.all(
      urls.map(
        async (url) => preview((await renderRoute(fixtureRoutes, url, { router: { head: fixtureHead } })).head).title,
      ),
    );
    expect(new Set(titles).size).toBe(urls.length);
  });
});
