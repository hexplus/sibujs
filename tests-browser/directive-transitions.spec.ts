/**
 * Real-browser validation of `when()` transitions — Chromium, Firefox, WebKit.
 *
 * The jsdom suite (`tests/directives-transitions.test.ts`) is the exhaustive
 * one, but jsdom neither runs CSS animations nor resolves animation
 * shorthands in computed styles, and it does not move focus out of an `inert`
 * subtree. This file checks those against real engines: the leave really waits
 * for the animation, a transition with two properties and a delay is waited out
 * in full, focus leaves the outgoing branch, and a reduced-motion stylesheet
 * makes the switch synchronous.
 */
import { expect, type Page, test } from "@playwright/test";

const FIXTURE = "/examples/directive-transitions-browser.html";

interface Panel {
  name: string;
  inert: boolean;
  hidden: string | null;
  leaving: boolean;
}
type T = {
  toggle: () => number;
  slide: () => number;
  pair: () => void;
  unmounted: () => { name: string; at: number }[];
  panels: () => Panel[];
  focused: () => string | null;
};

const t = (page: Page) => ({
  toggle: () => page.evaluate(() => (window as never as { __t: T }).__t.toggle()),
  slide: () => page.evaluate(() => (window as never as { __t: T }).__t.slide()),
  pair: () => page.evaluate(() => (window as never as { __t: T }).__t.pair()),
  unmounted: () => page.evaluate(() => (window as never as { __t: T }).__t.unmounted()),
  panels: () => page.evaluate(() => (window as never as { __t: T }).__t.panels()),
  focused: () => page.evaluate(() => (window as never as { __t: T }).__t.focused()),
});

async function open(page: Page) {
  await page.goto(FIXTURE);
  await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true);
  await expect(page.locator("#when-host .panel")).toHaveCount(1);
}

test("the old branch stays, inert, until its CSS animation ends; onUnmount runs then", async ({ page }) => {
  await open(page);
  const x = t(page);
  const switchedAt = await x.toggle();
  expect(await x.panels()).toEqual([
    { name: "B", inert: false, hidden: null, leaving: false },
    { name: "A", inert: true, hidden: "true", leaving: true },
  ]);
  expect(await x.unmounted()).toEqual([]);

  await expect(page.locator("#when-host .panel")).toHaveCount(1, { timeout: 3000 });
  const [entry] = await x.unmounted();
  expect(entry.name).toBe("A");
  // Not before the 200 ms animation, and well before the 5 s cap.
  expect(entry.at - switchedAt).toBeGreaterThanOrEqual(150);
  expect(entry.at - switchedAt).toBeLessThan(1500);
});

test("a two-property transition with a delay is waited out in full", async ({ page }) => {
  await open(page);
  const x = t(page);
  const switchedAt = await x.slide();
  await expect(page.locator(".slider")).toHaveCount(0, { timeout: 3000 });
  const elapsed = await page.evaluate((start) => performance.now() - start, switchedAt);
  // transform: 300 ms + 50 ms delay is the longest of the two.
  expect(elapsed).toBeGreaterThanOrEqual(300);
});

test("focus inside the leaving branch moves to its counterpart", async ({ page }) => {
  await open(page);
  const x = t(page);
  await page.locator('[data-branch="A"]').focus();
  await x.toggle();
  expect(await x.focused()).toBe("B");
});

test("a fragment branch leaves as a whole", async ({ page }) => {
  await open(page);
  const x = t(page);
  await expect(page.locator("[data-pair]")).toHaveCount(2);
  await x.pair();
  await expect(page.locator('[data-pair="none"]')).toHaveCount(1);
  await expect(page.locator('[data-pair="yes"], [data-pair="no"]')).toHaveCount(0, { timeout: 3000 });
  await x.pair();
  await expect(page.locator('[data-pair="yes"]:not([inert])')).toHaveCount(1);
});

test("with reduced motion the switch is synchronous", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  const x = t(page);
  await x.toggle();
  expect((await x.panels()).map((p) => p.name)).toEqual(["B"]);
  expect((await x.unmounted()).map((u) => u.name)).toEqual(["A"]);
});
