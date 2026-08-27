/**
 * Real-browser validation of the public-API hardening invariants.
 *
 * The jsdom suites assert these too, but each rests on something jsdom only
 * emulates and therefore cannot fully prove:
 *
 *   - jsdom never EXECUTES an `on*` attribute, so "the string never became a
 *     handler" is only observable against a real engine.
 *   - jsdom has no cascade, so "the generated scope selectors actually match a
 *     node inserted after render" needs `getComputedStyle` in a real one.
 *   - real Shadow DOM for micro-app teardown.
 *   - real scrolling and history for scroll restoration.
 */

import { expect, test } from "@playwright/test";

const PAGE = "/examples/public-api-hardening-browser.html";

test.beforeEach(async ({ page }) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
});

type Api = {
  svgStringHandlerIsInert(): { hasAttr: boolean; xssRan: boolean };
  svgFunctionHandlerStillWorks(): { fired: number; hasAttr: boolean };
  svgXlinkHrefNamespace(): { safeNS: string | null; unsafeNS: string | null };
  microAppDisposal(useShadow: boolean): { mountedText: string; afterRemount: number; afterUnmount: number };
  scopedStyleAppliesToLateNodes(): {
    earlyColor: string;
    lateColor: string;
    deepColor: string;
    rootColor: string;
  };
  setupScroll(): boolean;
  saveAt(key: string, y: number): { x: number; y: number };
  positionFor(key: string): { x: number; y: number } | null;
  disposeScroll(): boolean;
};

const api = <T>(page: import("@playwright/test").Page, fn: (t: Api) => T) =>
  page.evaluate(fn as never, undefined as never) as unknown as Promise<T>;

test("an SVG on* string never becomes a live handler", async ({ page }) => {
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.svgStringHandlerIsInert());
  expect(result.hasAttr).toBe(false);
  // The decisive assertion: a real engine would have run it.
  expect(result.xssRan).toBe(false);
});

test("an SVG function handler still attaches via addEventListener", async ({ page }) => {
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.svgFunctionHandlerStillWorks());
  expect(result.fired).toBe(1);
  expect(result.hasAttr).toBe(false);
});

test("xlink:href is written in the xlink namespace and URL-filtered", async ({ page }) => {
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.svgXlinkHrefNamespace());
  // A real renderer only honours the namespaced attribute.
  expect(result.safeNS).toBe("#icon");
  expect(result.unsafeNS ?? "").not.toContain("javascript:");
});

test("micro-app remount disposes the outgoing tree (light DOM)", async ({ page }) => {
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.microAppDisposal(false));
  expect(result.mountedText).toBe("first");
  expect(result.afterRemount).toBe(1);
  expect(result.afterUnmount).toBe(1);
});

test("micro-app remount disposes the outgoing tree (shadow root)", async ({ page }) => {
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.microAppDisposal(true));
  expect(result.mountedText).toBe("first");
  expect(result.afterRemount).toBe(1);
  expect(result.afterUnmount).toBe(1);
});

test("scoped styles reach descendants created after render", async ({ page }) => {
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.scopedStyleAppliesToLateNodes());
  // The root's own selector still applies…
  expect(result.rootColor).toBe("rgb(128, 0, 0)");
  // …descendants present at render time are styled…
  expect(result.earlyColor).toBe("rgb(0, 128, 0)");
  // …and so are the ones inserted afterwards, at any depth. This is the
  // assertion the old descendant-stamping implementation could not satisfy.
  expect(result.lateColor).toBe("rgb(0, 128, 0)");
  expect(result.deepColor).toBe("rgb(0, 128, 0)");
});

test("auto scroll restoration restores a destination on real popstate", async ({ page }) => {
  await page.evaluate(() => (window as never as { __t: Api }).__t.setupScroll());

  const a = await page.evaluate(() => (window as never as { __t: Api }).__t.saveAt("page-a", 800));
  expect(a.y).toBeGreaterThan(0);

  await page.evaluate(() => history.pushState({ __sibuScrollKey: "page-b" }, "", "#b"));
  await page.evaluate(() => (window as never as { __t: Api }).__t.saveAt("page-b", 200));

  // Real browser Back, real popstate, real scroll.
  await page.goBack();
  await page.waitForFunction(() => window.scrollY > 400, undefined, { timeout: 5000 });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(400);

  await page.evaluate(() => (window as never as { __t: Api }).__t.disposeScroll());
});

test("saved positions stay distinct per key", async ({ page }) => {
  await page.evaluate(() => (window as never as { __t: Api }).__t.setupScroll());
  await page.evaluate(() => (window as never as { __t: Api }).__t.saveAt("k1", 600));
  await page.evaluate(() => (window as never as { __t: Api }).__t.saveAt("k2", 150));

  const k1 = await page.evaluate(() => (window as never as { __t: Api }).__t.positionFor("k1"));
  const k2 = await page.evaluate(() => (window as never as { __t: Api }).__t.positionFor("k2"));

  expect(k1?.y).toBeGreaterThan(400);
  expect(k2?.y).toBeLessThan(400);
  await page.evaluate(() => (window as never as { __t: Api }).__t.disposeScroll());
});
