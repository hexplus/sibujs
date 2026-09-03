import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Host-framework interoperability, verified rather than asserted.
//
// `examples/interop-host.html` is a page whose main region is owned by a tiny
// client-side router that rewrites its markup on navigation — the situation any
// component framework creates. These tests pin the nine rules in docs/interop.md
// that a host has to satisfy, including the failure mode you get from skipping
// the disposer.
// ---------------------------------------------------------------------------

const PAGE = "/examples/interop-host.html";

const counts = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { hostExample: { counts(): { activations: number; live: number } } }).hostExample.counts());

const go = (page: import("@playwright/test").Page, id: string) => page.locator(`#${id}`).click();

test.beforeEach(async ({ page }) => {
  await page.goto(PAGE);
  await expect(page.locator('[data-sibu-island="sidebar"][data-sibu-enhanced="true"]')).toHaveCount(1);
});

test("an island outside the host's region is untouched by the host's navigations", async ({ page }) => {
  await page.locator('[data-sibu-island="sidebar"] [data-ref="inc"]').click();
  await page.locator('[data-sibu-island="sidebar"] [data-ref="inc"]').click();
  await expect(page.locator('[data-sibu-island="sidebar"] [data-ref="n"]')).toHaveText("2");

  await go(page, "go-widget");
  await go(page, "go-home");
  await go(page, "go-widget");

  // The sidebar kept its state and is still live: the host's disposer never
  // owned it, because mountIslands() was scoped to #app.
  await expect(page.locator('[data-sibu-island="sidebar"] [data-ref="n"]')).toHaveText("2");
  await page.locator('[data-sibu-island="sidebar"] [data-ref="inc"]').click();
  await expect(page.locator('[data-sibu-island="sidebar"] [data-ref="n"]')).toHaveText("3");
});

test("mountIslands() after the host renders activates the new markup", async ({ page }) => {
  expect(await counts(page)).toEqual({ activations: 0, live: 0 });

  await go(page, "go-widget");
  await expect(page.locator('[data-sibu-island="widget"][data-sibu-enhanced="true"]')).toHaveCount(1);
  expect(await counts(page)).toEqual({ activations: 1, live: 1 });

  await page.locator('[data-sibu-island="widget"] [data-ref="inc"]').click();
  await expect(page.locator('[data-sibu-island="widget"] [data-ref="n"]')).toHaveText("1");
});

test("disposing before the swap releases everything the setup opened", async ({ page }) => {
  await go(page, "go-widget");
  expect(await counts(page)).toEqual({ activations: 1, live: 1 });

  await go(page, "go-home");
  // The island is gone and its ctx.cleanup ran — no timer, no listener, no
  // binding survives the host's re-render.
  await expect(page.locator('[data-sibu-island="widget"]')).toHaveCount(0);
  expect(await counts(page)).toEqual({ activations: 1, live: 0 });
});

test("repeated navigation leaves exactly one live island, never a stack of them", async ({ page }) => {
  for (let i = 0; i < 5; i++) {
    await go(page, "go-widget");
    await go(page, "go-home");
  }
  await go(page, "go-widget");

  const { activations, live } = await counts(page);
  expect(activations).toBe(6);
  expect(live).toBe(1); // one activation outstanding, five cleaned up
  await expect(page.locator('[data-sibu-island="widget"]')).toHaveCount(1);

  // And it works, rather than merely existing.
  await page.locator('[data-sibu-island="widget"] [data-ref="inc"]').click();
  await expect(page.locator('[data-sibu-island="widget"] [data-ref="n"]')).toHaveText("1");
});

test("skipping the disposer strands the island's own resources — the documented bug", async ({ page }) => {
  await go(page, "go-widget");
  expect(await counts(page)).toEqual({ activations: 1, live: 1 });

  // The host replaces the markup WITHOUT calling the disposer first.
  await go(page, "leak-nav");

  // The DOM is gone, but the setup's cleanup never ran: its interval is still
  // scheduled. This is rule 2, stated as a failing outcome rather than advice.
  await expect(page.locator('[data-sibu-island="widget"]')).toHaveCount(0);
  expect((await counts(page)).live).toBe(1);
});

test("a second mountIslands() over live islands does not double-wire them", async ({ page }) => {
  await go(page, "go-widget");
  await page.locator('[data-sibu-island="widget"] [data-ref="inc"]').click();
  await expect(page.locator('[data-sibu-island="widget"] [data-ref="n"]')).toHaveText("1");

  const before = await counts(page);
  // A host that re-scans after every render — the recommended strategy.
  await page.evaluate(() => import("../dist/index.js").then((m) => m.mountIslands(document)));

  // No new activation: the live island was skipped, not enhanced a second time.
  expect(await counts(page)).toEqual(before);
  await page.locator('[data-sibu-island="widget"] [data-ref="inc"]').click();
  // Still exactly one increment per click — no duplicate listener.
  await expect(page.locator('[data-sibu-island="widget"] [data-ref="n"]')).toHaveText("2");
});
