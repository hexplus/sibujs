/**
 * Real-browser hydration validation — Chromium, Firefox, WebKit.
 *
 * Required by the SSR/hydration hardening plan: hydration cannot be classified
 * production-ready from jsdom alone. jsdom does not reproduce real event
 * dispatch, real form/focus behaviour, or real history traversal.
 */
import { expect, test } from "@playwright/test";

const FIXTURE = "/examples/hydration-browser.html";

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true);
});

const t = <T>(page: import("@playwright/test").Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ([f, a]) => {
      const api = (window as never as { __t: Record<string, (...x: unknown[]) => unknown> }).__t;
      return api[f as string](...(a as unknown[]));
    },
    [fn, args] as const,
  ) as Promise<T>;

test.describe("matching hydration", () => {
  test("renders the expected content and marks the container hydrated", async ({ page }) => {
    await t(page, "hydrateMatch");

    await expect(page.locator("#m-root")).toHaveText("Hello");
    await expect(page.locator("#match")).toHaveAttribute("data-sibu-hydrated", "true");
    expect(await page.locator("#m-root").count()).toBe(1);
  });

  test("does not duplicate DOM", async ({ page }) => {
    await t(page, "hydrateMatch");
    expect(await page.locator("#match .box").count()).toBe(1);
    expect(await page.locator("#match").innerText()).toBe("Hello");
  });

  test("replaces rather than adopts the server node (documented characteristic)", async ({ page }) => {
    await t(page, "capture", "#m-root");
    expect(await t<boolean>(page, "sameNode", "#m-root")).toBe(true);

    await t(page, "hydrateMatch");

    // SibuJS uses a replace strategy: the server node is discarded. This is
    // asserted, not assumed — see docs/architecture/hydration.md.
    expect(await t<boolean>(page, "sameNode", "#m-root")).toBe(false);
  });
});

test.describe("events and reactivity after hydration", () => {
  test("fires exactly one callback per real click", async ({ page }) => {
    await t(page, "hydrateCounter");

    await page.click("#c-btn");
    let counts = await page.evaluate(() => (window as never as { __t: { counts: Record<string, number> } }).__t.counts);
    expect(counts.click).toBe(1);

    await page.click("#c-btn");
    counts = await page.evaluate(() => (window as never as { __t: { counts: Record<string, number> } }).__t.counts);
    expect(counts.click).toBe(2);
  });

  test("updates the DOM reactively after hydration", async ({ page }) => {
    await t(page, "hydrateCounter");

    await expect(page.locator("#c-val")).toHaveText("0");
    await page.click("#c-btn");
    await expect(page.locator("#c-val")).toHaveText("1");
    await page.click("#c-btn");
    await expect(page.locator("#c-val")).toHaveText("2");
  });

  test("hydrates the component tree exactly once", async ({ page }) => {
    await t(page, "hydrateCounter");
    const counts = await page.evaluate(
      () => (window as never as { __t: { counts: Record<string, number> } }).__t.counts,
    );
    expect(counts.render).toBe(1);
  });
});

test.describe("mismatch recovery", () => {
  test("recovers from a text mismatch with the client value", async ({ page }) => {
    await t(page, "hydrateTextMismatch");

    await expect(page.locator("#t-root")).toHaveText("Goodbye");
    expect(await page.locator("#text-mismatch span").count()).toBe(1);
  });

  test("recovers from a structural mismatch without leaving extra nodes", async ({ page }) => {
    await t(page, "hydrateStructMismatch");

    expect(await page.locator("#s-root span").count()).toBe(1);
    await expect(page.locator("#s-root")).toHaveText("Hello");
    expect(await page.locator("#struct-mismatch").innerText()).not.toContain("Unexpected");
  });
});

test.describe("forms", () => {
  test("client state wins over pre-hydration user input (documented)", async ({ page }) => {
    // A real user types before the bundle hydrates.
    await page.fill("#f-input", "Bob");
    expect(await page.inputValue("#f-input")).toBe("Bob");

    await t(page, "hydrateForm");

    // Replace strategy discards the edit. Recorded as a real-browser fact.
    expect(await page.inputValue("#f-input")).toBe("Alice");
  });

  test("checkbox is interactive after hydration", async ({ page }) => {
    await t(page, "hydrateForm");

    expect(await page.isChecked("#f-check")).toBe(false);
    await page.check("#f-check");
    expect(await page.isChecked("#f-check")).toBe(true);
  });

  test("input accepts typing after hydration", async ({ page }) => {
    await t(page, "hydrateForm");

    await page.fill("#f-input", "Carol");
    expect(await page.inputValue("#f-input")).toBe("Carol");
  });
});

test.describe("islands", () => {
  test("hydrates only the requested island", async ({ page }) => {
    await t(page, "hydrateIsland", "alpha");

    await expect(page.locator('[data-sibu-island="alpha"]')).toContainText("alpha-client");
    // Beta must still show its untouched server markup.
    await expect(page.locator('[data-sibu-island="beta"]')).toContainText("beta-server");
  });

  test("hydrating a second island later leaves the first intact", async ({ page }) => {
    await t(page, "hydrateIsland", "alpha");
    await t(page, "hydrateIsland", "beta");

    await expect(page.locator('[data-sibu-island="alpha"]')).toContainText("alpha-client");
    await expect(page.locator('[data-sibu-island="beta"]')).toContainText("beta-client");
  });
});

test.describe("SSR → hydration → client routing", () => {
  test("navigates client-side after hydration", async ({ page }) => {
    await t(page, "setupRouter");

    await page.click("#r-link-user");
    await expect(page.locator(".page")).toHaveAttribute("data-page", "user");
    expect(new URL(page.url()).pathname).toBe("/users/42");
    expect(await t<Record<string, string>>(page, "routeParams")).toEqual({ id: "42" });
  });

  test("RouterLink with a nested child works after hydration", async ({ page }) => {
    await t(page, "setupRouter");

    await page.click("#r-link-about .inner");
    await expect(page.locator(".page")).toHaveAttribute("data-page", "about");
  });

  test("back returns to the hydrated route", async ({ page }) => {
    await t(page, "setupRouter");

    await page.click("#r-link-user");
    await expect(page.locator(".page")).toHaveAttribute("data-page", "user");

    await page.goBack();
    await expect(page.locator(".page")).toHaveAttribute("data-page", "home");
    expect(new URL(page.url()).pathname).toBe(FIXTURE);
  });

  test("router setup after hydration does not push a history entry", async ({ page }) => {
    const before = await t<number>(page, "historyLength");

    await t(page, "setupRouter");
    await page.waitForTimeout(100);

    // Bootstrapping must not duplicate the initial URL in history.
    expect(await t<number>(page, "historyLength")).toBe(before);
  });

  test("the SPA survives the whole sequence without a page reload", async ({ page }) => {
    await t(page, "setupRouter");
    await page.click("#r-link-user");
    await page.click("#r-link-about .inner");

    // Module scope intact means no full document navigation occurred.
    expect(await page.evaluate(() => (window as never as { __ready?: boolean }).__ready)).toBe(true);
  });
});
