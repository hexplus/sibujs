/**
 * Real-browser proof that `srcdoc` payloads never execute and that dynamic
 * `html` styles are actually sanitized.
 *
 * jsdom can only tell us an attribute is absent — it never parses a `srcdoc`
 * value as a document, and it has no cascade. Both properties therefore need a
 * real engine: the payload here actively sets a marker on `parent` and
 * `postMessage`s, so a pass means the nested document genuinely did not run,
 * and the style assertions read `getComputedStyle`.
 *
 * A control case sets `srcdoc` natively, bypassing SibuJS, and asserts the
 * payload DOES execute — without it, "no execution" could just mean the probe
 * was broken.
 *
 * No `sandbox` attribute is used anywhere: sandboxing would neutralise the
 * payload regardless of whether SibuJS removed the attribute, hiding the very
 * thing under test.
 */

import { expect, test } from "@playwright/test";

const PAGE = "/examples/srcdoc-security-browser.html";

type Api = {
  reset(): boolean;
  viaHtmlTemplate(): { hasSrcdoc: boolean; title: string | null };
  viaBindAttrs(): { hasSrcdoc: boolean };
  viaBindDynamic(): { hasSrcdoc: boolean };
  controlThatShouldExecute(): { hasSrcdoc: boolean };
  observed(): { xss: boolean; messages: number };
  dynamicStyle(): {
    attr: string;
    color: string;
    fontWeight: string;
    backgroundImage: string;
  };
  dynamicStyleMixed(): { attr: string; color: string; backgroundImage: string };
};

test.beforeEach(async ({ page }) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await page.evaluate(() => (window as never as { __t: Api }).__t.reset());
});

test("the probe itself works — a natively-set srcdoc DOES execute", async ({ page }) => {
  const built = await page.evaluate(() => (window as never as { __t: Api }).__t.controlThatShouldExecute());
  expect(built.hasSrcdoc).toBe(true);

  await page.waitForFunction(() => (window as unknown as { __XSS: boolean }).__XSS === true, undefined, {
    timeout: 5000,
  });

  const observed = await page.evaluate(() => (window as never as { __t: Api }).__t.observed());
  expect(observed.xss, "control payload did not run — the rest of this file proves nothing").toBe(true);
});

test("html template: a dynamic srcdoc never executes and is absent", async ({ page }) => {
  const built = await page.evaluate(() => (window as never as { __t: Api }).__t.viaHtmlTemplate());
  expect(built.hasSrcdoc).toBe(false);
  expect(built.title, "an unrelated attribute was lost").toBe("probe");

  // Give a real document every chance to load and run.
  await page.waitForTimeout(250);
  const observed = await page.evaluate(() => (window as never as { __t: Api }).__t.observed());
  expect(observed.xss, "the srcdoc payload executed").toBe(false);
  expect(observed.messages).toBe(0);
});

test("bindAttrs: an existing srcdoc is removed and never executes", async ({ page }) => {
  const built = await page.evaluate(() => (window as never as { __t: Api }).__t.viaBindAttrs());
  expect(built.hasSrcdoc, "a pre-existing srcdoc survived").toBe(false);

  await page.waitForTimeout(250);
  const observed = await page.evaluate(() => (window as never as { __t: Api }).__t.observed());
  expect(observed.xss).toBe(false);
  expect(observed.messages).toBe(0);
});

test("bindDynamic: an existing srcdoc is removed and never executes", async ({ page }) => {
  const built = await page.evaluate(() => (window as never as { __t: Api }).__t.viaBindDynamic());
  expect(built.hasSrcdoc).toBe(false);

  await page.waitForTimeout(250);
  const observed = await page.evaluate(() => (window as never as { __t: Api }).__t.observed());
  expect(observed.xss).toBe(false);
  expect(observed.messages).toBe(0);
});

test("dynamic html style is sanitized in the real cascade", async ({ page }) => {
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.dynamicStyle());

  // Safe declarations survive…
  expect(result.color).toBe("rgb(0, 128, 0)");
  expect(result.fontWeight).toBe("700");

  // …and the remote url() is gone from both the attribute and the cascade, so
  // no request is ever attempted.
  expect(result.attr).not.toContain("url(");
  expect(result.backgroundImage, "the engine resolved a background image").toBe("none");
});

test("mixed static + dynamic html style is sanitized too", async ({ page }) => {
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.dynamicStyleMixed());

  expect(result.color).toBe("rgb(0, 0, 255)");
  expect(result.attr).not.toContain("url(");
  expect(result.backgroundImage).toBe("none");
});
