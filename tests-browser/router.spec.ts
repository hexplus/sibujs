/**
 * Real-browser router validation — Chromium, Firefox, WebKit.
 *
 * jsdom simulates `history` and dispatches synthetic events; it does not
 * reproduce real back/forward traversal, modifier-click semantics, or the
 * browser's own handling of `target="_blank"`, `download`, and external
 * origins. Everything in this file depends on native behaviour and cannot be
 * meaningfully asserted in jsdom.
 */
import { expect, test } from "@playwright/test";

const FIXTURE = "/examples/router-browser.html";

/** Modifier that opens a link in a new tab on this platform. */
const newTabModifier = (browserName: string): "Meta" | "Control" =>
  browserName === "webkit" ? "Meta" : "Control";

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true);
});

const routerPath = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as never as { __router: { path: () => string } }).__router.path());

/**
 * Assert the router did NOT handle a click as a client-side navigation.
 *
 * Engines differ in what they do natively with modifier/middle clicks:
 * Chromium fires `auxclick` (no `click` at all) and opens a new tab; WebKit
 * performs a real same-tab navigation. Both are correct *browser* behaviour and
 * neither is the router's business. What matters is only this: the SPA must
 * never still be alive with its route silently changed underneath it.
 */
async function expectNoClientSideNavigation(page: import("@playwright/test").Page, forbiddenPath: string) {
  const spaAlive = await page.evaluate(() => (window as never as { __ready?: boolean }).__ready === true);

  if (!spaAlive) {
    // The document actually navigated — the browser handled it, not the router.
    return;
  }
  // SPA intact: the route must be untouched.
  expect(await routerPath(page)).not.toBe(forbiddenPath);
}

test.describe("history integration", () => {
  test("pushState navigation updates location and rendered route", async ({ page }) => {
    await page.click("#link-users");

    await expect(page.locator(".page")).toHaveAttribute("data-page", "users");
    expect(new URL(page.url()).pathname).toBe("/users");
    expect(await routerPath(page)).toBe("/users");
  });

  test("browser back returns to the previous route", async ({ page }) => {
    await page.click("#link-users");
    await expect(page.locator(".page")).toHaveAttribute("data-page", "users");

    await page.goBack();

    await expect(page.locator(".page")).toHaveAttribute("data-page", "home");
    expect(new URL(page.url()).pathname).toBe(FIXTURE);
  });

  test("browser forward re-applies the route", async ({ page }) => {
    await page.click("#link-users");
    await expect(page.locator(".page")).toHaveAttribute("data-page", "users");

    await page.goBack();
    await expect(page.locator(".page")).toHaveAttribute("data-page", "home");

    await page.goForward();
    await expect(page.locator(".page")).toHaveAttribute("data-page", "users");
    expect(new URL(page.url()).pathname).toBe("/users");
  });

  test("back/forward does not create extra history entries", async ({ page }) => {
    const lengthAtStart = await page.evaluate(() => history.length);

    await page.click("#link-users");
    await page.click("#link-about");
    const lengthAfterTwoPushes = await page.evaluate(() => history.length);
    expect(lengthAfterTwoPushes).toBe(lengthAtStart + 2);

    await page.goBack();
    await page.goBack();
    await page.goForward();

    // Traversal must not push new entries.
    expect(await page.evaluate(() => history.length)).toBe(lengthAfterTwoPushes);
  });

  test("rapid back/forward settles on the correct final route", async ({ page }) => {
    await page.click("#link-users");
    await page.click("#link-about");

    await page.goBack();
    await page.goBack();
    await page.goForward();
    await page.goForward();

    await expect(page.locator(".page")).toHaveAttribute("data-page", "about");
    expect(await routerPath(page)).toBe("/about");
    expect(new URL(page.url()).pathname).toBe("/about");
  });

  test("replace navigation does not add a history entry", async ({ page }) => {
    const before = await page.evaluate(() => history.length);

    await page.evaluate(async () => {
      const { replace } = await import("../dist/plugins.js");
      await replace("/about");
    });

    await expect(page.locator(".page")).toHaveAttribute("data-page", "about");
    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  test("router state and location agree after traversal", async ({ page }) => {
    await page.click("#link-users");
    await page.click("#link-about");
    await page.goBack();

    const path = await routerPath(page);
    expect(path).toBe(new URL(page.url()).pathname);
  });
});

test.describe("link interception (RouterLink)", () => {
  test("intercepts a same-origin primary-button click", async ({ page }) => {
    await page.click("#link-about");

    await expect(page.locator(".page")).toHaveAttribute("data-page", "about");
    // Interception means no document reload — module scope survives.
    expect(await page.evaluate(() => (window as never as { __ready?: boolean }).__ready)).toBe(true);
  });

  test("resolves the anchor when a nested element is clicked", async ({ page }) => {
    // The click target is the <span>, not the <a>.
    await page.click("#link-users .label");

    await expect(page.locator(".page")).toHaveAttribute("data-page", "users");
    expect(new URL(page.url()).pathname).toBe("/users");
    expect(await page.evaluate(() => (window as never as { __ready?: boolean }).__ready)).toBe(true);
  });

  test("does not intercept a modifier-click", async ({ page, context, browserName }) => {
    const popupPromise = context.waitForEvent("page", { timeout: 4000 }).catch(() => null);

    await page.click("#link-about", { modifiers: [newTabModifier(browserName)] }).catch(() => {});

    await expectNoClientSideNavigation(page, "/about");
    const popup = await popupPromise;
    if (popup) await popup.close();
  });

  test("does not intercept a shift-click", async ({ page, context }) => {
    const popupPromise = context.waitForEvent("page", { timeout: 4000 }).catch(() => null);

    await page.click("#link-about", { modifiers: ["Shift"] }).catch(() => {});

    await expectNoClientSideNavigation(page, "/about");
    const popup = await popupPromise;
    if (popup) await popup.close();
  });

  test("does not intercept a middle-click", async ({ page, context }) => {
    const popupPromise = context.waitForEvent("page", { timeout: 3000 }).catch(() => null);

    await page.click("#link-about", { button: "middle" }).catch(() => {});

    await expectNoClientSideNavigation(page, "/about");
    const popup = await popupPromise;
    if (popup) await popup.close();
  });

  test('does not intercept target="_blank"', async ({ page, context }) => {
    const popupPromise = context.waitForEvent("page", { timeout: 4000 }).catch(() => null);

    await page.click("#link-blank").catch(() => {});

    await expectNoClientSideNavigation(page, "/about");
    const popup = await popupPromise;
    if (popup) await popup.close();
  });

  test("respects an app handler that called preventDefault", async ({ page }) => {
    await page.click("#link-prevented");

    const events = await page.evaluate(() => (window as never as { __router: { events: string[] } }).__router.events);
    expect(events).toContain("prevented-handler-ran");

    // INVARIANT: a link whose default was already prevented must not navigate.
    expect(new URL(page.url()).pathname).toBe(FIXTURE);
    expect(await routerPath(page)).toBe(FIXTURE);
  });

  test("a plain <a href> is NOT intercepted (documented behaviour)", async ({ page }) => {
    // SibuJS installs no global click handler: only RouterLink intercepts.
    // A plain anchor performs a real browser navigation, which leaves the SPA.
    await page.click("#plain-link").catch(() => {});
    await page.waitForLoadState("load").catch(() => {});

    // Module scope is gone — proof the document actually navigated.
    const stillSpa = await page.evaluate(() => (window as never as { __ready?: boolean }).__ready === true);
    expect(stillSpa).toBe(false);
  });
});

test.describe("hash and params", () => {
  test("navigates to a hash target", async ({ page }) => {
    await page.click("#link-hash");

    await expect(page.locator(".page")).toHaveAttribute("data-page", "about");
    expect(page.url()).toContain("#section");
  });

  test("extracts dynamic params from a real navigation", async ({ page }) => {
    await page.evaluate(async () => {
      await (window as never as { __router: { navigate: (t: string) => Promise<unknown> } }).__router.navigate(
        "/users/42",
      );
    });

    await expect(page.locator(".page")).toHaveAttribute("data-page", "user-detail");
    const params = await page.evaluate(
      () => (window as never as { __router: { params: () => Record<string, string> } }).__router.params(),
    );
    expect(params.id).toBe("42");
  });

  test("decodes an encoded param", async ({ page }) => {
    await page.evaluate(async () => {
      await (window as never as { __router: { navigate: (t: string) => Promise<unknown> } }).__router.navigate(
        "/users/hello%20world",
      );
    });

    const params = await page.evaluate(
      () => (window as never as { __router: { params: () => Record<string, string> } }).__router.params(),
    );
    expect(params.id).toBe("hello world");
  });
});

test.describe("focus behaviour", () => {
  test("navigation does not steal focus from a focused input", async ({ page }) => {
    await page.focus("#focus-input");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("focus-input");

    await page.evaluate(async () => {
      await (window as never as { __router: { navigate: (t: string) => Promise<unknown> } }).__router.navigate(
        "/about",
      );
    });
    await expect(page.locator(".page")).toHaveAttribute("data-page", "about");

    // Documented behaviour: the router delegates focus entirely to the app and
    // does not move it on navigation.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("focus-input");
  });

  test("focus survives back/forward traversal", async ({ page }) => {
    await page.click("#link-users");
    await page.focus("#focus-input");

    await page.goBack();
    await expect(page.locator(".page")).toHaveAttribute("data-page", "home");

    // The router must not blur or refocus anything of its own accord.
    const active = await page.evaluate(() => document.activeElement?.id ?? "");
    expect(["focus-input", "", "body"]).toContain(active);
  });
});


/**
 * Navigation-target policy in a real engine. jsdom cannot show what a browser
 * actually does with an external `<a href>`, a `javascript:` URI, or a
 * protocol-relative host, so the policy is re-proved here per engine.
 */
test.describe("navigation target policy", () => {
  type Click = { id: string | null; href: string | null; intercepted: boolean };
  const lastClick = (page: import("@playwright/test").Page) =>
    page.evaluate(() => (window as never as { __router: { lastClick: () => Click } }).__router.lastClick());

  test("does not SPA-intercept an external absolute URL", async ({ page }) => {
    const before = await routerPath(page);
    await page.click("#link-external");

    const click = await lastClick(page);
    // A real, working external href — RouterLink is not an external-navigation
    // API, so the browser's own behaviour is left untouched.
    expect(click.href).toBe("https://example.com/");
    expect(click.intercepted).toBe(false);

    // The SPA is still alive and its route is unchanged: nothing was routed.
    expect(await page.evaluate(() => (window as never as { __ready?: boolean }).__ready === true)).toBe(true);
    expect(await routerPath(page)).toBe(before);
  });

  for (const [id, label] of [
    ["#link-proto-relative", "protocol-relative"],
    ["#link-js", "javascript:"],
    ["#link-data", "data:"],
    ["#link-vbscript", "vbscript:"],
  ] as const) {
    test(`neutralizes a ${label} target`, async ({ page }) => {
      const before = await routerPath(page);
      await page.click(id);

      const click = await lastClick(page);
      // No executable href is ever exposed to the engine…
      expect(click.href).toBe("#");
      // …and the click is swallowed rather than routed or followed.
      expect(click.intercepted).toBe(true);
      expect(await routerPath(page)).toBe(before);
      // Nothing in a dangerous URI ever executed.
      expect(await page.evaluate(() => (window as never as { __pwned?: boolean }).__pwned)).toBeUndefined();
    });
  }

  test("still SPA-intercepts an internal target", async ({ page }) => {
    await page.click("#link-match-users");

    const click = await lastClick(page);
    expect(click.href).toBe("/users");
    expect(click.intercepted).toBe(true);
    expect(await routerPath(page)).toBe("/users");
  });
});

/**
 * Active-class matching in a real engine, driven through genuine `pushState`
 * navigation rather than a synthetic route signal.
 */
test.describe("RouterLink active matching", () => {
  const classOf = (page: import("@playwright/test").Page, id: string) =>
    page.evaluate((elId) => (window as never as { __router: { classOf: (i: string) => string } }).__router.classOf(elId), id);

  test("does not mark /user active on /users", async ({ page }) => {
    await page.click("#link-match-users");
    expect(await routerPath(page)).toBe("/users");

    // Segment boundaries are respected: /user is not a prefix-match for /users.
    expect(await classOf(page, "link-match-user")).not.toContain("router-link-active");
    expect(await classOf(page, "link-match-users")).toContain("router-link-active");
    expect(await classOf(page, "link-match-users")).toContain("router-link-exact-active");
  });

  test("marks /user active but not exact on /user/123", async ({ page }) => {
    await page.evaluate(() =>
      (window as never as { __router: { navigate: (t: string) => Promise<unknown> } }).__router.navigate("/user/123"),
    );
    await expect(page.locator(".page")).toHaveAttribute("data-page", "user-detail-singular");

    expect(await classOf(page, "link-match-user")).toContain("router-link-active");
    expect(await classOf(page, "link-match-user")).not.toContain("router-link-exact-active");
    // The plural link is unrelated to /user/123.
    expect(await classOf(page, "link-match-users")).not.toContain("router-link-active");
  });

  test("does not mark the root link active on a non-root route", async ({ page }) => {
    await page.click("#link-match-users");
    expect(await routerPath(page)).toBe("/users");

    expect(await classOf(page, "link-match-root")).not.toContain("router-link-active");
  });

  test("exact-active distinguishes query and hash targets", async ({ page }) => {
    await page.evaluate(() =>
      (window as never as { __router: { navigate: (t: string) => Promise<unknown> } }).__router.navigate("/about?q=b"),
    );
    await expect(page.locator(".page")).toHaveAttribute("data-page", "about");

    // Same pathname, different query — active but not the *same* target.
    expect(await classOf(page, "link-query-a")).toContain("router-link-active");
    expect(await classOf(page, "link-query-a")).not.toContain("router-link-exact-active");

    await page.evaluate(() =>
      (window as never as { __router: { navigate: (t: string) => Promise<unknown> } }).__router.navigate("/about#two"),
    );
    expect(await classOf(page, "link-hash-one")).toContain("router-link-active");
    expect(await classOf(page, "link-hash-one")).not.toContain("router-link-exact-active");
  });
});
