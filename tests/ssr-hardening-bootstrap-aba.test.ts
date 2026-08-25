/**
 * RM-002 — stale `hydrateRouter()` bootstrap must lose commit permission
 * permanently once superseded, even if the browser returns to the same URL.
 *
 * A URL-equality guard cannot express this: `/b` generation 10 and `/b`
 * generation 12 are the same string but different navigation generations. These
 * tests assert **ownership**, not URL — a stale bootstrap that replaces the
 * newer instance's DOM would destroy its signals, effects, listeners and
 * lifecycle even though `location`, `route()` and `textContent` all still look
 * correct.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onCleanup } from "../src/core/rendering/lifecycle";
import {
  __getNavigationEpoch,
  createRouter,
  destroyRouter,
  navigate,
  Route,
  route,
  setRoutes,
} from "../src/plugins/router";
import { hydrateRouter } from "../src/plugins/routerSSR";

const SSR_ROUTE_STATE_KEY = "__SIBU_ROUTE_STATE__";

/**
 * Navigations settle on microtasks; hydrateRouter's dynamic import needs a
 * macrotask. Draining microtasks only therefore observes the state *while the
 * bootstrap is still pending* — which is exactly the race window under test.
 */
const drainMicrotasks = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

/** hydrateRouter loads `platform/ssr` via dynamic import — settles on a macrotask. */
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 8; j++) await Promise.resolve();
  }
};

let instanceCounter = 0;
const cleanupsByInstance = new Map<number, number>();

/** A route component with an observable instance identity and cleanup count. */
function trackedPage(name: string) {
  return () => {
    const id = ++instanceCounter;
    cleanupsByInstance.set(id, 0);
    const el = document.createElement("div");
    el.className = "page";
    el.setAttribute("data-page", name);
    el.setAttribute("data-instance", String(id));
    el.textContent = `page:${name}`;
    onCleanup(() => {
      cleanupsByInstance.set(id, (cleanupsByInstance.get(id) ?? 0) + 1);
    }, el);
    return el;
  };
}

const ROUTES = [
  { path: "/a", component: trackedPage("a") },
  { path: "/b", component: trackedPage("b") },
  { path: "/c", component: trackedPage("c") },
  { path: "/d", component: trackedPage("d") },
  { path: "/search", component: trackedPage("search") },
];

function serverRendered(serverPath: string, browserUrl: string) {
  const container = document.createElement("div");
  container.id = "app";
  // Distinct class: `.page` must match ONLY real route components, otherwise
  // querySelector(".page") returns the inert server node and the assertions
  // silently measure the wrong element.
  container.innerHTML = `<div class="server-markup">server</div>`;
  document.body.appendChild(container);

  (window as unknown as Record<string, unknown>)[SSR_ROUTE_STATE_KEY] = {
    path: serverPath,
    params: {},
    query: {},
    hash: "",
    meta: {},
  };
  window.history.replaceState({}, "", browserUrl);
  return container;
}

const domInstance = (c: HTMLElement) => c.querySelector(".page")?.getAttribute("data-instance") ?? null;
const domPage = (c: HTMLElement) => c.querySelector(".page")?.getAttribute("data-page") ?? null;

describe("bootstrap ownership: generation-based supersession", () => {
  let container: HTMLElement;

  beforeEach(() => {
    instanceCounter = 0;
    cleanupsByInstance.clear();
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    destroyRouter();
    container?.remove();
    (window as unknown as Record<string, unknown>)[SSR_ROUTE_STATE_KEY] = undefined;
    vi.restoreAllMocks();
  });

  it("Case A — a bootstrap with no competing navigation hydrates normally", async () => {
    container = serverRendered("/a", "/b");

    hydrateRouter(ROUTES as never, { container });
    await settle();

    expect(route().path).toBe("/b");
    expect(window.location.pathname).toBe("/b");
    expect(domPage(container)).toBe("b");
    // The bootstrap really did take ownership — server markup is gone.
    expect(domInstance(container)).not.toBeNull();
  });

  it("Case B — a simple supersession leaves the newer route the owner", async () => {
    container = serverRendered("/a", "/b");

    hydrateRouter(ROUTES as never, { container });
    // Navigate away before the bootstrap chunk resolves.
    const nav = navigate("/c");
    container.appendChild(Route());
    await nav;
    await settle();

    expect(route().path).toBe("/c");
    // The stale /b bootstrap must not have committed.
    expect(domPage(container)).not.toBe("b");
  });

  it("Case C — ABA: /b → /c → /b, the NEW /b instance keeps ownership", async () => {
    container = serverRendered("/a", "/b");

    hydrateRouter(ROUTES as never, { container });
    // Outlet so navigations actually render into the container.
    container.appendChild(Route());

    // Supersede, then return to the very same URL the bootstrap targeted.
    await navigate("/c");
    await navigate("/b");
    // Still mid-race: the bootstrap import has not resolved yet.
    await drainMicrotasks();

    const ownerInstance = domInstance(container);
    expect(ownerInstance).not.toBeNull();
    expect(domPage(container)).toBe("b");
    const ownerId = Number(ownerInstance);

    // Now release the long-superseded bootstrap.
    await settle();
    await settle();

    // INVARIANT: the instance created by the NEW /b navigation still owns the
    // DOM. A URL-equality guard would have let the old bootstrap back in here,
    // since both generations are "/b".
    expect(domInstance(container)).toBe(String(ownerId));
    // And its lifecycle was never torn down by a stale replacement.
    expect(cleanupsByInstance.get(ownerId)).toBe(0);
  });

  it("Case D — multiple ABA transitions: /b → /c → /b → /d → /b", async () => {
    container = serverRendered("/a", "/b");

    hydrateRouter(ROUTES as never, { container });
    container.appendChild(Route());

    await navigate("/c");
    await navigate("/b");
    await navigate("/d");
    await navigate("/b");
    await drainMicrotasks();

    const ownerId = Number(domInstance(container));
    expect(domPage(container)).toBe("b");

    await settle();
    await settle();

    expect(domInstance(container)).toBe(String(ownerId));
    expect(cleanupsByInstance.get(ownerId)).toBe(0);
  });

  it("Case E — query ABA: ?q=a → ?q=b → ?q=a rejects the stale bootstrap", async () => {
    container = serverRendered("/search", "/search?q=a");

    hydrateRouter(ROUTES as never, { container });
    container.appendChild(Route());

    await navigate("/search?q=b");
    await navigate("/search?q=a");
    await drainMicrotasks();

    const ownerId = Number(domInstance(container));
    expect(route().query.q).toBe("a");

    await settle();
    await settle();

    expect(domInstance(container)).toBe(String(ownerId));
    expect(cleanupsByInstance.get(ownerId)).toBe(0);
  });

  it("Case F — a destroyed router invalidates a pending bootstrap", async () => {
    container = serverRendered("/a", "/b");

    hydrateRouter(ROUTES as never, { container });
    destroyRouter();
    const markupAtDestroy = container.innerHTML;

    await settle();
    await settle();

    // No commit into a torn-down router's container.
    expect(container.innerHTML).toBe(markupAtDestroy);
  });

  it("does not regress RM-001 — the live URL still beats the server route", async () => {
    container = serverRendered("/a", "/b");

    hydrateRouter(ROUTES as never, { container });
    await settle();

    expect(window.location.pathname).toBe("/b");
    expect(route().path).toBe("/b");
    expect(domPage(container)).toBe("b");
    expect(domPage(container)).not.toBe("a");
  });
});

/**
 * Direct proof of the ownership primitive.
 *
 * The end-to-end ABA window is timing-sensitive (hydrateRouter's dynamic import
 * is warm, so its continuation fires on the first macrotask). These tests prove
 * the property that actually matters, without depending on that timing: an
 * A→B→A round trip leaves the URL identical but the navigation generation
 * strictly advanced. Any guard built on URL equality is therefore structurally
 * incapable of rejecting superseded work; a generation-based one is not.
 */
describe("bootstrap ownership: why URL equality is insufficient", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes(ROUTES);
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("A→B→A returns to the same URL under a strictly newer generation", async () => {
    await navigate("/b");
    const urlAtStart = window.location.pathname;
    const epochAtStart = __getNavigationEpoch();

    await navigate("/c");
    await navigate("/b");

    // The URL guard cannot tell these two moments apart...
    expect(window.location.pathname).toBe(urlAtStart);
    // ...but the generation can.
    expect(__getNavigationEpoch()).toBeGreaterThan(epochAtStart);
  });

  it("advances the generation monotonically across repeated ABA cycles", async () => {
    await navigate("/b");
    let previous = __getNavigationEpoch();

    for (let i = 0; i < 5; i++) {
      await navigate("/c");
      await navigate("/b");
      const now = __getNavigationEpoch();
      expect(now).toBeGreaterThan(previous);
      expect(window.location.pathname).toBe("/b");
      previous = now;
    }
  });

  it("advances the generation for a query-only round trip", async () => {
    await navigate("/search?q=a");
    const epochAtStart = __getNavigationEpoch();
    const urlAtStart = window.location.pathname + window.location.search;

    await navigate("/search?q=b");
    await navigate("/search?q=a");

    expect(window.location.pathname + window.location.search).toBe(urlAtStart);
    expect(__getNavigationEpoch()).toBeGreaterThan(epochAtStart);
  });

  it("does not advance the generation when nothing navigates", async () => {
    await navigate("/b");
    const epoch = __getNavigationEpoch();

    await drainMicrotasks();
    await settle();

    // A quiet bootstrap must retain its commit permission.
    expect(__getNavigationEpoch()).toBe(epoch);
  });

  it("advances the generation on router teardown", async () => {
    await navigate("/b");
    const epoch = __getNavigationEpoch();

    destroyRouter();

    expect(__getNavigationEpoch()).not.toBe(epoch);
  });
});
