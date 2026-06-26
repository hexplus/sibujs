import { expect, test } from "@playwright/test";

// Real-browser validation of lazy island code-loading over HTTP — ES-module
// `import()` is blocked over file://, so this one needs the static server
// (see playwright.config.ts `webServer`).

test("lazy island code is fetched only on activation, then enhances in place", async ({ page }) => {
  const moduleRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("lazy-hello.js")) moduleRequests.push(req.url());
  });

  await page.goto("/examples/islands-lazy.html");

  const value = page.locator('[data-sibu-island="hello"] [data-ref="v"]');

  // `interaction` strategy → the module must NOT be fetched yet (ships ~0 JS).
  await expect(value).toHaveText("pending");
  expect(moduleRequests, "module fetched before activation").toHaveLength(0);

  // Activate → the module is fetched on demand and the island enhances in place.
  await page.locator('[data-sibu-island="hello"] [data-ref="go"]').click();
  await expect(value).toHaveText("lazy-loaded (0)");
  expect(moduleRequests.length, "module not fetched on activation").toBeGreaterThan(0);

  // The enhanced island is interactive (event wired by the lazy module).
  await value.click();
  await expect(value).toHaveText("lazy-loaded (1)");
});
