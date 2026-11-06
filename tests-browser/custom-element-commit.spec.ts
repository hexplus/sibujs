/**
 * Real-browser validation that commits survive synchronous custom-element
 * reactions — Chromium, Firefox, WebKit.
 *
 * Removing or inserting a custom element runs its `disconnectedCallback` /
 * `connectedCallback` before the DOM operation returns. The jsdom suite
 * (`tests/custom-element-commit-callbacks.test.ts`) is the exhaustive one; this
 * file checks the same outcomes on real engines' reaction timing:
 *
 * - a `connectedCallback` disposing the renderer during the insertion releases
 *   the incoming content once — core `lazy()` and `Suspense`, `Route`, nested
 *   `Outlet`, router `Suspense` — and the work it captured stops reacting;
 * - a `disconnectedCallback` disposing the renderer during the staged
 *   replacement (core `Suspense` whose content is its fallback's own root)
 *   discards the content once and never re-inserts it;
 * - a cached `KeepAliveRoute` page whose disconnection disposes the outlet is
 *   released with it, once.
 */
import { expect, type Page, test } from "@playwright/test";

const FIXTURE = "/examples/custom-element-commit-browser.html";

const call = <R = unknown>(page: Page, name: string) =>
  page.evaluate(
    (n) => (window as never as { __t: Record<string, () => unknown> }).__t[n](),
    name,
  ) as Promise<R>;

interface Report {
  state: string | null;
  reacted: boolean;
  cleanups: number;
}
interface Counts {
  connected: number;
  disconnected: number;
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true);
});

test("core lazy(): a connectedCallback disposing the container ends the instance once", async ({ page }) => {
  const r = await call<Report & { rootCleanups: number; counts: Counts; cleanupsAfter: number }>(
    page,
    "lazyConnectedDispose",
  );
  expect(r.counts.connected).toBe(1);
  expect(r.rootCleanups).toBe(1);
  expect(r.state).toBe("ended");
  expect(r.reacted).toBe(false);
  expect(r.cleanups).toBe(1);
  expect(r.cleanupsAfter).toBe(1);
});

test("core lazy(): repeated mounts whose connection disposes them all end", async ({ page }) => {
  const r = await call<{ states: string[]; cleanups: number }>(page, "lazyRepeated");
  expect(r.states).toEqual(["ended", "ended", "ended", "ended"]);
  expect(r.cleanups).toBe(4);
});

test("core Suspense: content that is its fallback's root, disposing the boundary on disconnection, is never re-inserted", async ({
  page,
}) => {
  const r = await call<
    Report & { initial: boolean; children: number; connected: boolean; rootCleanups: number; counts: Counts }
  >(page, "suspenseSharedRoot");
  expect(r.initial).toBe(true);
  expect(r.children).toBe(0);
  expect(r.connected).toBe(false);
  expect(r.rootCleanups).toBe(1);
  expect(r.counts).toEqual({ connected: 1, disconnected: 1 });
  expect(r.state).toBe("ended");
  expect(r.reacted).toBe(false);
  expect(r.cleanups).toBe(1);
});

test("core Suspense: a content connectedCallback disposing the boundary ends content and fallback once", async ({
  page,
}) => {
  const r = await call<{ rootCleanups: number; content: Report; fallback: Report }>(page, "suspenseConnectedDispose");
  expect(r.rootCleanups).toBe(1);
  for (const w of [r.content, r.fallback]) {
    expect(w.state).toBe("ended");
    expect(w.reacted).toBe(false);
    expect(w.cleanups).toBe(1);
  }
});

test("Route: a connectedCallback disposing the outlet releases the page once", async ({ page }) => {
  const r = await call<Report & { rootCleanups: number; counts: Counts; children: number }>(
    page,
    "routeConnectedDispose",
  );
  expect(r.counts.connected).toBe(1);
  expect(r.rootCleanups).toBe(1);
  expect(r.children).toBe(1);
  expect(r.state).toBe("ended");
  expect(r.reacted).toBe(false);
  expect(r.cleanups).toBe(1);
});

test("Outlet: a connectedCallback disposing the nested outlet releases the child once", async ({ page }) => {
  const r = await call<Report & { rootCleanups: number; counts: Counts; layoutChildren: number }>(
    page,
    "outletConnectedDispose",
  );
  expect(r.counts.connected).toBe(1);
  expect(r.rootCleanups).toBe(1);
  expect(r.layoutChildren).toBe(1);
  expect(r.state).toBe("ended");
  expect(r.reacted).toBe(false);
  expect(r.cleanups).toBe(1);
});

test("KeepAliveRoute: a cached page whose disconnection disposes the outlet is released once", async ({ page }) => {
  const r = await call<Report & { rootCleanups: number; b: boolean }>(page, "keepAliveDisconnectDispose");
  expect(r.rootCleanups).toBe(1);
  expect(r.b).toBe(false);
  expect(r.state).toBe("ended");
  expect(r.reacted).toBe(false);
  expect(r.cleanups).toBe(1);
});

test("router Suspense: a connectedCallback disposing the boundary releases the content once", async ({ page }) => {
  const r = await call<{ rootCleanups: number; counts: Counts; children: number }>(
    page,
    "routerSuspenseConnectedDispose",
  );
  expect(r.counts.connected).toBe(1);
  expect(r.rootCleanups).toBe(1);
  expect(r.children).toBe(1);
});
