import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStubFetch } from "../fixtures/ssr-app/src/api";
import { head, routes } from "../fixtures/ssr-app/src/routes";
import { __resetQueryCache } from "../src/data/query";
import { createRenderHandler } from "../src/platform/renderHandler";

let stub: ReturnType<typeof createStubFetch>;

beforeEach(() => {
  stub = createStubFetch();
  vi.stubGlobal("fetch", stub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetQueryCache();
});

const req = (path: string, method = "GET") => new Request(`http://sidecar.local${path}`, { method });

describe("createRenderHandler — a Node render sidecar", () => {
  it("answers a full document with the route's status and caching headers", async () => {
    const handle = createRenderHandler(routes, { router: { head }, document: { scripts: ["/assets/main.js"] } });
    const res = await handle(req("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=600");
    const html = await res.text();
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html.match(/<article class="card"/g)?.length).toBe(3);
    expect(html).toContain('<script src="/assets/main.js"></script>');
  });

  it("answers redirects with Location and no body, 404 with its page and no-store", async () => {
    const handle = createRenderHandler(routes, { router: { head } });
    const moved = await handle(req("/cotizacion"));
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("/cotizar");
    expect(moved.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await moved.text()).toBe("");
    const missing = await handle(req("/nope"));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(await missing.text()).toContain("Página no encontrada");
  });

  it("serves HEAD without a body and refuses other methods", async () => {
    const handle = createRenderHandler(routes, { router: { head } });
    const res = await handle(req("/", "HEAD"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect((await handle(req("/", "POST"))).status).toBe(405);
  });

  it("caches rendered pages by URL and data version", async () => {
    let version = 1;
    const handle = createRenderHandler(routes, { router: { head }, cache: { version: () => version } });
    const first = await handle(req("/"));
    expect(first.headers.get("x-sibu-cache")).toBe("miss");
    const second = await handle(req("/"));
    expect(second.headers.get("x-sibu-cache")).toBe("hit");
    expect(second.headers.get("cache-control")).toBe(first.headers.get("cache-control"));
    expect(await second.text()).toBe(await first.text());
    expect(stub.calls.filter((p) => p === "/api/catalog").length).toBe(1);
    version = 2;
    const third = await handle(req("/"));
    expect(third.headers.get("x-sibu-cache")).toBe("miss");
    expect(stub.calls.filter((p) => p === "/api/catalog").length).toBe(2);
    // Different URLs, different entries.
    expect((await handle(req("/cotizar?servicio=dtf"))).headers.get("x-sibu-cache")).toBe("miss");
  });

  it("evicts the least recently used page past `max`", async () => {
    const handle = createRenderHandler(routes, { router: { head }, cache: { max: 1 } });
    await handle(req("/galeria"));
    await handle(req("/cotizar"));
    expect((await handle(req("/galeria"))).headers.get("x-sibu-cache")).toBe("miss");
  });
});
