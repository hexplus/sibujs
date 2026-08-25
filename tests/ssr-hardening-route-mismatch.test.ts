/**
 * Initial server/client route mismatch.
 *
 * Governing invariant (§43, §76): after bootstrap completes,
 *
 *   rendered DOM  ==  router.currentRoute  ==  location
 *
 * must all describe the same logical location. A stale server route may not
 * survive merely because it was present in the initial HTML.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { div } from "../src/core/rendering/html";
import { destroyRouter, navigate, route } from "../src/plugins/router";
import { hydrateRouter } from "../src/plugins/routerSSR";

/**
 * hydrateRouter loads `platform/ssr` via a dynamic import, which settles on a
 * macrotask — microtask draining alone is not enough, and a test that only
 * drained microtasks would pass vacuously whenever the server markup happened
 * to match the expectation.
 */
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 8; j++) await Promise.resolve();
  }
};

const SSR_ROUTE_STATE_KEY = "__SIBU_ROUTE_STATE__";

const page = (name: string) => () => {
  const d = div({ class: "page", "data-page": name }, `page:${name}`) as HTMLElement;
  return d;
};

const ROUTES = [
  { path: "/a", component: page("a") },
  { path: "/b", component: page("b") },
  { path: "/users/:id", component: page("user") },
  { path: "/search", component: page("search") },
  { path: "/docs", component: page("docs") },
];

/** Simulate a server-rendered page: seed state + markup, set the browser URL. */
function serverRendered(serverPath: string, browserUrl: string) {
  const container = document.createElement("div");
  container.id = "app";
  // Inert server markup for the SERVER's route.
  const serverName = serverPath.split("?")[0].split("#")[0];
  container.innerHTML = `<div class="page" data-page="${serverName.replace(/^\//, "").split("/")[0]}">server</div>`;
  document.body.appendChild(container);

  (window as unknown as Record<string, unknown>)[SSR_ROUTE_STATE_KEY] = {
    path: serverPath.split("?")[0].split("#")[0],
    params: {},
    query: {},
    hash: "",
    meta: {},
  };

  window.history.replaceState({}, "", browserUrl);
  return container;
}

function currentDomPage(container: HTMLElement): string | null {
  return container.querySelector(".page")?.getAttribute("data-page") ?? null;
}

describe("initial route mismatch: bootstrap coherence", () => {
  let container: HTMLElement;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    destroyRouter();
    container?.remove();
    (window as unknown as Record<string, unknown>)[SSR_ROUTE_STATE_KEY] = undefined;
    vi.restoreAllMocks();
  });

  it("agrees on DOM, router and location when server and client match", async () => {
    container = serverRendered("/a", "/a");

    hydrateRouter(ROUTES as never, { container });
    await settle();

    expect(route().path).toBe("/a");
    expect(window.location.pathname).toBe("/a");
    expect(currentDomPage(container)).toBe("a");
  });

  it("renders the BROWSER's route when the server rendered a different one", async () => {
    // Stale cached HTML for /a delivered to a browser sitting at /b.
    container = serverRendered("/a", "/b");

    hydrateRouter(ROUTES as never, { container });
    await settle();

    // INVARIANT: all three must agree, and they must agree on /b — the live URL.
    expect(window.location.pathname).toBe("/b");
    expect(route().path).toBe("/b");
    expect(currentDomPage(container)).toBe("b");
  });

  it("resolves a dynamic-param mismatch to the browser's params", async () => {
    container = serverRendered("/users/1", "/users/2");

    hydrateRouter(ROUTES as never, { container });
    await settle();

    expect(window.location.pathname).toBe("/users/2");
    expect(route().path).toBe("/users/2");
    expect(route().params.id).toBe("2");
    expect(currentDomPage(container)).toBe("user");
  });

  it("resolves a query mismatch to the browser's query", async () => {
    container = serverRendered("/search", "/search?q=client");

    hydrateRouter(ROUTES as never, { container });
    await settle();

    expect(route().path).toBe("/search");
    expect(route().query.q).toBe("client");
    expect(currentDomPage(container)).toBe("search");
  });

  it("resolves a hash mismatch to the browser's hash", async () => {
    container = serverRendered("/docs", "/docs#two");

    hydrateRouter(ROUTES as never, { container });
    await settle();

    expect(route().path).toBe("/docs");
    expect(window.location.hash).toBe("#two");
    expect(currentDomPage(container)).toBe("docs");
  });

  it("does not create a duplicate history entry during bootstrap", async () => {
    container = serverRendered("/a", "/b");
    const before = window.history.length;

    hydrateRouter(ROUTES as never, { container });
    await settle();

    // Recovering from a mismatch must not push /b on top of /b.
    expect(window.history.length).toBe(before);
    expect(window.location.pathname).toBe("/b");
  });

  it("keeps router and location coherent after a post-bootstrap navigation", async () => {
    container = serverRendered("/a", "/b");

    hydrateRouter(ROUTES as never, { container });
    await settle();
    expect(currentDomPage(container)).toBe("b");

    await navigate("/a");
    await settle();

    expect(route().path).toBe("/a");
    expect(window.location.pathname).toBe("/a");
    // CHARACTERISATION: hydrateRouter is a one-shot bootstrap — it renders the
    // initial route and does NOT install a reactive outlet. Ongoing route
    // rendering is the application's job via `Route()`. The bootstrapped DOM
    // therefore still shows the initial route here, which is correct.
    expect(currentDomPage(container)).toBe("b");
  });

  it("a stale bootstrap must not overwrite a navigation that raced ahead of it", async () => {
    container = serverRendered("/a", "/b");

    hydrateRouter(ROUTES as never, { container });
    // User clicks through before the bootstrap chunk finishes loading.
    await navigate("/docs");
    await settle();

    expect(route().path).toBe("/docs");
    expect(window.location.pathname).toBe("/docs");
    // INVARIANT: the superseded bootstrap may not commit /b's content on top
    // of the newer navigation.
    expect(currentDomPage(container)).not.toBe("b");
  });

  it("falls back to a plain client router when there is no server state", async () => {
    container = document.createElement("div");
    container.id = "app";
    document.body.appendChild(container);
    (window as unknown as Record<string, unknown>)[SSR_ROUTE_STATE_KEY] = undefined;
    window.history.replaceState({}, "", "/b");

    hydrateRouter(ROUTES as never, { container });
    await settle();

    expect(route().path).toBe("/b");
    expect(window.location.pathname).toBe("/b");
  });

  it("does not leave stale server markup for an unmatched browser route", async () => {
    container = serverRendered("/a", "/definitely-unknown");

    hydrateRouter(ROUTES as never, { container });
    await settle();

    // No route matches, so no stale /a content may remain on screen.
    expect(currentDomPage(container)).not.toBe("a");
    expect(route().path).toBe("/definitely-unknown");
  });
});
