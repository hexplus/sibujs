import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

// Real-browser validation of the island activation strategies. jsdom lacks
// IntersectionObserver / requestIdleCallback / matchMedia, so these paths have
// only ever run their fallbacks in the unit tests — this exercises the real APIs.

const here = dirname(fileURLToPath(import.meta.url));
const STRATEGIES = pathToFileURL(resolve(here, "..", "examples", "islands-strategies.html")).href;

const state = (name: string) => `[data-sibu-island="${name}"] [data-ref="s"]`;

test("load and idle islands activate on their own", async ({ page }) => {
  await page.goto(STRATEGIES);
  await expect(page.locator(state("s-load"))).toHaveText("active");
  await expect(page.locator(state("s-idle"))).toHaveText("active"); // requestIdleCallback
});

test("media island honors the matchMedia query and its change events", async ({ page }) => {
  // Start below the breakpoint → stays pending.
  await page.setViewportSize({ width: 500, height: 800 });
  await page.goto(STRATEGIES);
  await expect(page.locator(state("s-media"))).toHaveText("pending");

  // Cross the (min-width: 600px) breakpoint → the change listener activates it.
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.locator(state("s-media"))).toHaveText("active");
});

test("interaction island waits for a real interaction", async ({ page }) => {
  await page.goto(STRATEGIES);
  // Should not have activated on load.
  await expect(page.locator(state("s-interaction"))).toHaveText("pending");

  await page.locator('[data-sibu-island="s-interaction"] [data-ref="b"]').click();
  await expect(page.locator(state("s-interaction"))).toHaveText("active");
});

test("visible island activates only when scrolled into view", async ({ page }) => {
  await page.goto(STRATEGIES);
  // It's below a full-viewport spacer → pending until scrolled to.
  await expect(page.locator(state("s-visible"))).toHaveText("pending");

  await page.locator('[data-sibu-island="s-visible"]').scrollIntoViewIfNeeded();
  await expect(page.locator(state("s-visible"))).toHaveText("active"); // IntersectionObserver
});
