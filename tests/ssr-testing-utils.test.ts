import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStubFetch } from "../fixtures/ssr-app/src/api";
import { head, routes } from "../fixtures/ssr-app/src/routes";
import { div, p } from "../src/core/rendering/html";
import { isServer } from "../src/core/ssr-context";
import { __resetQueryCache } from "../src/data/query";
import { createRouter, destroyRouter, Route, routerReady } from "../src/plugins/router";
import { hydrateInTest, renderOnServer } from "../src/testing";

beforeEach(() => {
  vi.stubGlobal("fetch", createStubFetch());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetQueryCache();
  destroyRouter();
  delete (window as unknown as Record<string, unknown>).__SIBU_TRANSFER__;
});

describe("renderOnServer()", () => {
  it("renders a URL of the fixture app and queries its HTML and head", async () => {
    const page = await renderOnServer(routes, { url: "/cotizar?servicio=bordado", router: { head } });
    expect(page.status).toBe(200);
    expect(page.text("h1")).toBe("Cotiza tu pedido");
    expect(page.getByText("Servicio: bordado")?.tagName).toBe("P");
    expect(page.queryAll("option")).toHaveLength(3);
    expect(page.title()).toBe("Cotizar · Estampados Sibu");
    expect(page.meta("description")).toBe("Cotización de bordado");
    expect(page.meta("og:site_name")).toBe("Estampados Sibu");
  });

  it("reports redirects and 404s", async () => {
    const moved = await renderOnServer(routes, { url: "/cotizacion", router: { head } });
    expect([moved.status, moved.location]).toEqual([301, "/cotizar"]);
    const missing = await renderOnServer(routes, { url: "/x", router: { head } });
    expect(missing.status).toBe(404);
  });

  it("renders a component", async () => {
    const page = await renderOnServer(() => div([p({ class: "x" }, "hi")]));
    expect(page.text(".x")).toBe("hi");
  });
});

describe("hydrateInTest()", () => {
  it("adopts the fixture landing page: only the ClientOnly canvases are created, and no mismatch", async () => {
    const server = await renderOnServer(routes, { url: "/", router: { head }, hydration: "adopt" });
    createRouter(routes, { mode: "memory", url: "/", head });
    await routerReady();
    const report = await hydrateInTest(server.html, () => Route(), { strategy: "adopt", state: server.state });
    expect(report.mismatches).toEqual([]);
    // The three <canvas> the product cards swap in after adoption; nothing else.
    expect(report.created).toBe(3);
    expect(report.adopted).toBeGreaterThan(20);
    report.cleanup();
  });

  it("reports the replace strategy's created nodes, and an adoption's mismatches", async () => {
    const App = () => div([isServer() ? p("server") : div("client")]);
    const server = await renderOnServer(App, { hydration: "adopt" });
    const replaced = await hydrateInTest(server.html, App);
    expect(replaced.created).toBe(2);
    replaced.cleanup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const adopted = await hydrateInTest(server.html, App, { strategy: "adopt" });
    expect(adopted.mismatches.map((m) => m.kind)).toEqual(["tag", "extra"]);
    expect(adopted.created).toBe(1);
    adopted.cleanup();
  });
});
