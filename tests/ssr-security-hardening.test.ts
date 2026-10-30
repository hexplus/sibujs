import { afterEach, describe, expect, it, vi } from "vitest";
import { div, p } from "../src/core/rendering/html";
import { query } from "../src/data/query";
import { Head } from "../src/platform/head";
import { createRenderHandler } from "../src/platform/renderHandler";
import { renderRoute } from "../src/platform/renderRoute";
import { renderToReadableStream, renderToString, serializeState } from "../src/platform/ssr";
import type { RouteDef } from "../src/plugins/router";

// Hardening of the 4.14 server-rendering paths found in the OWASP review.

afterEach(() => {
  vi.restoreAllMocks();
});

async function readAll(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += value;
  }
}

describe("redirect Location built from request data", () => {
  const routes: RouteDef[] = [
    { path: "/", component: () => p("home") },
    { path: "/old/:slug", redirect: (to) => `/new/${to.params.slug}` },
    { path: "/new/:slug", component: () => p("new") },
  ];

  it("percent-encodes CR/LF and non-Latin-1 characters, keeping existing escapes", async () => {
    const crlf = await renderRoute(routes, "/old/a%0D%0ASet-Cookie:x=1");
    expect(crlf.status).toBe(302);
    expect(crlf.location).toBe("/new/a%0D%0ASet-Cookie:x=1");
    const euro = await renderRoute(routes, "/old/%E2%82%AC");
    expect(euro.location).toBe("/new/%E2%82%AC");
    const plain = await renderRoute(routes, "/old/a-b_c.d");
    expect(plain.location).toBe("/new/a-b_c.d");
  });

  it("is answered by createRenderHandler instead of rejecting", async () => {
    const handle = createRenderHandler(routes);
    const res = await handle(new Request("http://x.test/old/%0D%0Ainjected"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/new/%0D%0Ainjected");
  });
});

describe("createRenderHandler failures and cache bounds", () => {
  it("answers a render that throws with a bare 500, without the error text", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const routes: RouteDef[] = [{ path: "/", component: () => p("home") }];
    const handle = createRenderHandler(routes);
    const app = createRenderHandler(routes, {
      app: () => {
        throw new Error("secret connection string");
      },
    });
    const res = await app(new Request("http://x.test/"));
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toBe("Internal Server Error");
    expect(body).not.toContain("secret");
    expect(logged).toHaveBeenCalled();
    // A handler that renders fine still does.
    expect((await handle(new Request("http://x.test/"))).status).toBe(200);
  });

  it("keeps the cache within maxBytes however many query strings a client invents", async () => {
    const routes: RouteDef[] = [{ path: "/", component: () => p("x".repeat(1000)) }];
    const handle = createRenderHandler(routes, { cache: { maxBytes: 5000 } });
    for (let i = 0; i < 20; i++) {
      expect((await handle(new Request(`http://x.test/?v=${i}`))).headers.get("x-sibu-cache")).toBe("miss");
    }
    // The newest pages are cached; the oldest were evicted to stay in budget.
    expect((await handle(new Request("http://x.test/?v=19"))).headers.get("x-sibu-cache")).toBe("hit");
    expect((await handle(new Request("http://x.test/?v=0"))).headers.get("x-sibu-cache")).toBe("miss");
  });

  it("neither caches nor marks shareable a page that timed out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const routes: RouteDef[] = [
      {
        path: "/",
        component: () => {
          const q = query("never", () => new Promise<string>(() => {}));
          return p(() => q.data() ?? "loading");
        },
      },
    ];
    const handle = createRenderHandler(routes, { timeout: 30, cache: {} });
    const res = await handle(new Request("http://x.test/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Rendered and not stored.
    expect(res.headers.get("x-sibu-cache")).toBe("bypass");
    expect((await handle(new Request("http://x.test/"))).headers.get("x-sibu-cache")).toBe("bypass");
  });
});

describe("transferred state with a __proto__ key", () => {
  it("is read in the browser with the key as own data, as on the server", () => {
    const data = JSON.parse('{"a":{"__proto__":{"isAdmin":true},"name":"x"}}');
    const script = serializeState(data, undefined, { global: "__T__" });
    expect(script).toContain("JSON.parse(");
    const body = /<script>([\s\S]*)<\/script>/.exec(script)?.[1] ?? "";
    new Function(body)();
    const read = (window as unknown as { __T__: { a: Record<string, unknown> } }).__T__;
    expect(Object.getPrototypeOf(read.a)).toBe(Object.prototype);
    expect((read.a as { isAdmin?: boolean }).isAdmin).toBeUndefined();
    expect(Object.hasOwn(read.a, "__proto__")).toBe(true);
    expect(read.a.name).toBe("x");
    delete (window as unknown as Record<string, unknown>).__T__;
  });

  it("keeps the plain literal form for ordinary data, escaping intact", () => {
    const script = serializeState({ a: "</script><script>alert(1)</script>" });
    expect(script).not.toContain("JSON.parse(");
    expect(script).not.toContain("</script><script>");
  });
});

describe("serializer: comment text cannot close the comment at its start", () => {
  it("escapes data beginning with > or ->", () => {
    for (const data of [">", "-><img src=x onerror=alert(1)>", "><img src=x onerror=alert(1)>", "a<!-"]) {
      const root = div([document.createComment(data)]);
      const html = renderToString(root);
      const parsed = document.createElement("div");
      parsed.innerHTML = html;
      expect(parsed.querySelector("img"), data).toBeNull();
      expect(parsed.firstElementChild?.childNodes.length, data).toBe(1);
      expect(parsed.firstElementChild?.firstChild?.nodeType, data).toBe(8);
    }
  });
});

describe("streamed document markers cannot be forged by request data", () => {
  it("keeps the body and scripts when a head value holds marker-like text", async () => {
    const NUL = String.fromCharCode(0);
    const title = `${NUL}sibu-body${NUL} <sibu-stream-body> ${NUL}sibu-end${NUL} <sibu-stream-end>`;
    const html = await readAll(
      renderToReadableStream(() => div([Head({ title }), p("the body")]), { document: { scripts: ["/main.js"] } }),
    );
    expect(html).toContain("<p>the body</p>");
    expect(html).toContain('<script src="/main.js"></script>');
    expect(html.trim().endsWith("</html>")).toBe(true);
    expect(html).not.toContain("undefined");
    expect(html.indexOf("<p>the body</p>")).toBeGreaterThan(html.indexOf("</title>"));
  });
});
