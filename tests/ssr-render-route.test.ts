import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStubFetch } from "../fixtures/ssr-app/src/api";
import { head, routes } from "../fixtures/ssr-app/src/routes";
import { __resetQueryCache } from "../src/data/query";
import { renderRoute } from "../src/platform/renderRoute";
import { createRouter, destroyRouter, navigate, route, routerReady } from "../src/plugins/router";

let stub: ReturnType<typeof createStubFetch>;

beforeEach(() => {
  stub = createStubFetch();
  vi.stubGlobal("fetch", stub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetQueryCache();
});

const render = (url: string, extra: Parameters<typeof renderRoute>[2] = {}) =>
  renderRoute(routes, url, { router: { head }, ...extra });

describe("renderRoute — the fixture app", () => {
  it("renders / with the fetched product grid, status 200 and the route head", async () => {
    const r = await render("/");
    expect(r.status).toBe(200);
    expect(r.location).toBeNull();
    expect(r.route?.name).toBe("home");
    expect(r.html.match(/<article class="card"/g)?.length).toBe(3);
    expect(r.html).toContain("Camiseta &quot;DTF&quot; &lt;premium&gt;".replace(/&quot;/g, '"'));
    expect(stub.calls).toEqual(["/api/catalog"]);
    expect(r.head).toContain("<title>Inicio · Estampados Sibu</title>");
    expect(r.head).toContain(
      '<meta property="og:image" content="https://fixture.test/og/home.png" data-sibu-head="" />',
    );
    expect(r.stateData).toMatchObject({ q: { "/api/catalog": { d: expect.any(Array) } } });
  });

  it("renders a param route", async () => {
    const r = await render("/producto/gorra");
    expect(r.status).toBe(200);
    expect(r.route?.params).toEqual({ id: "gorra" });
    expect(r.html).toContain("<h1>Gorra bordada</h1>");
    expect(r.head).toContain("<title>Producto gorra · Estampados Sibu</title>");
    expect(r.head).toContain('<link rel="canonical" href="https://fixture.test/producto/gorra" data-sibu-head="" />');
  });

  it("renders a query route; route().query works during the server render", async () => {
    const r = await render("/cotizar?servicio=bordado");
    expect(r.status).toBe(200);
    expect(r.route?.query).toEqual({ servicio: "bordado" });
    expect(r.html).toContain("Servicio: bordado");
    expect(r.html).toContain('<option value="bordado">Bordado</option>');
    expect(r.head).toContain('<meta name="description" content="Cotización de bordado" data-sibu-head="" />');
  });

  it("answers a redirect with its status and Location, and renders no body", async () => {
    // A static redirect target replaces the whole location, query included,
    // exactly as the browser router does.
    const r = await render("/cotizacion?servicio=dtf");
    expect(r.status).toBe(301);
    expect(r.location).toBe("/cotizar");
    expect(r.html).toBe("");
  });

  it("prefixes Location with the router base", async () => {
    const r = await render("/cotizacion", { router: { head, base: "/tienda" } });
    expect(r.location).toBe("/tienda/cotizar");
  });

  it("answers 404 for the * route, with its page and head", async () => {
    const r = await render("/no-existe");
    expect(r.status).toBe(404);
    expect(r.route?.name).toBe("not-found");
    expect(r.html).toContain("No existe /no-existe");
    expect(r.noindex).toBe(true);
  });

  it("renders a lazy route", async () => {
    const r = await render("/galeria");
    expect(r.status).toBe(200);
    expect(r.html).toContain("<h1>Galería de trabajos</h1>");
    expect(r.html).not.toContain("Loading");
  });

  it("renders a nested layout with Outlet()", async () => {
    const r = await render("/ayuda/envios");
    expect(r.status).toBe(200);
    expect(r.html).toContain("<h1>Centro de ayuda</h1>");
    expect(r.html).toContain("Entregamos en 48 horas");
    expect(r.head).toContain("<title>Envíos · Estampados Sibu</title>");
  });

  it("maps a guard rejection to 403 (configurable), with no body", async () => {
    const r = await render("/mi-cuenta");
    expect(r.status).toBe(403);
    expect(r.failure).toBe("guard");
    expect(r.html).toBe("");
    const r401 = await render("/mi-cuenta", { rejectStatus: 401 });
    expect(r401.status).toBe(401);
  });

  it("maps a guard redirect to 302 + Location", async () => {
    const r = await render("/pedidos");
    expect(r.status).toBe(302);
    expect(r.location).toBe("/");
    expect(r.html).toBe("");
  });

  it('renders only the shell and head for a render: "client" route', async () => {
    const r = await render("/disenador");
    expect(r.status).toBe(200);
    expect(r.render).toBe("client");
    expect(r.html).toBe("");
    expect(r.head).toContain("<title>Diseñador · Estampados Sibu</title>");
  });

  it("wraps the result in a full document on request", async () => {
    const r = await render("/", { document: { scripts: ["/assets/main.js"] } });
    expect(r.html).toMatch(/^<!DOCTYPE html>/);
    expect(r.html).toContain("<title>Inicio · Estampados Sibu</title>");
    expect(r.html).toContain('<div id="app"><!--route-outlet--><main class="landing"');
    expect(r.html.indexOf("window.__SIBU_TRANSFER__")).toBeLessThan(r.html.indexOf('<script src="/assets/main.js">'));
  });

  it("isolates concurrent renders: each request has its own router, route and data", async () => {
    const [a, b, c] = await Promise.all([render("/producto/taza"), render("/cotizar?servicio=vinil"), render("/")]);
    expect(a.html).toContain("Taza personalizada");
    expect(a.html).not.toContain("Cotiza tu pedido");
    expect(b.html).toContain("Servicio: vinil");
    expect(c.html.match(/<article class="card"/g)?.length).toBe(3);
    expect(a.stateData).toMatchObject({ q: { "/api/catalog/taza": expect.anything() } });
    expect(a.stateData?.q).not.toHaveProperty("/api/catalog");
    expect(c.stateData?.q).not.toHaveProperty("/api/catalog/taza");
  });

  it("does not touch the process-wide router", async () => {
    await render("/cotizar");
    expect(() => route()).toThrow(/Router not initialized/);
  });
});

describe('createRouter({ mode: "memory", url })', () => {
  it("starts at url and navigates without touching the browser location", async () => {
    const push = vi.spyOn(window.history, "pushState");
    const before = window.location.href;
    createRouter(
      [
        { path: "/a", component: () => document.createElement("div") },
        { path: "/b", component: () => document.createElement("div") },
      ],
      {
        mode: "memory",
        url: "/a?x=1",
      },
    );
    await routerReady();
    expect(route().path).toBe("/a");
    expect(route().query).toEqual({ x: "1" });
    await navigate("/b#top");
    expect(route().path).toBe("/b");
    expect(route().hash).toBe("top");
    expect(push).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    destroyRouter();
  });
});

describe('createRouter({ trailingSlash: "ignore" })', () => {
  it("resolves /cotizar/ to the /cotizar route; the default stays strict", async () => {
    const strict = await render("/cotizar/");
    expect(strict.status).toBe(404);
    const loose = await renderRoute(routes, "/cotizar/", { router: { head, trailingSlash: "ignore" } });
    expect(loose.status).toBe(200);
    expect(loose.route?.path).toBe("/cotizar");
    expect(loose.html).toContain("Cotiza tu pedido");
  });
});
