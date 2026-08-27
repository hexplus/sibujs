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
  scopedFunctionalPseudos(): {
    alpha: string;
    beta: string;
    gammaPlain: string;
    gammaExcluded: string;
    leaf: string;
    comma: string;
  };
  setupScroll(): boolean;
  setupAutoRoundTrip(): { nativeMode: string; initialTag: string | undefined };
  autoScrollTo(y: number): number;
  autoPushEntry(key: string, url: string): string | undefined;
  autoObserved(): { calls: Array<{ x: number; y: number }>; y: number };
  autoPositions(): { A: { x: number; y: number } | null; B: { x: number; y: number } | null };
  teardownAutoRoundTrip(): string;
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

test("scoped selector lists survive functional pseudo-classes", async ({ page }) => {
  const c = await page.evaluate(() => (window as never as { __t: Api }).__t.scopedFunctionalPseudos());

  // `:is(.alpha, .beta)` must still match BOTH arms. Splitting on the comma
  // produced a selector that matched neither.
  expect(c.alpha).toBe("rgb(0, 0, 255)");
  expect(c.beta).toBe("rgb(0, 0, 255)");

  // `:not(.x, .y)` must exclude both arms and keep everything else.
  expect(c.gammaPlain).toBe("rgb(0, 128, 0)");
  expect(c.gammaExcluded).not.toBe("rgb(0, 128, 0)");

  // `:where(...) > .leaf` keeps its combinator and its argument list.
  expect(c.leaf).toBe("rgb(255, 0, 0)");

  // A comma inside an attribute value is ordinary text.
  expect(c.comma).toBe("rgb(128, 0, 128)");
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

test("auto mode restores Back and Forward with native restoration disabled", async ({ page }) => {
  const setup = await page.evaluate(() => (window as never as { __t: Api }).__t.setupAutoRoundTrip());

  // Two preconditions that make the rest of this test meaningful: SibuJS owns
  // the browser's restoration, and the entry the page STARTED on has identity.
  expect(setup.nativeMode, "the browser was left restoring in parallel").toBe("manual");
  expect(setup.initialTag, "the initial history entry was never tagged").toBe("A");

  // Scroll A, then navigate to B. Note there is no manual save("A") anywhere.
  await page.evaluate(() => (window as never as { __t: Api }).__t.autoScrollTo(900));
  const bTag = await page.evaluate(() => (window as never as { __t: Api }).__t.autoPushEntry("B", "#b"));
  expect(bTag).toBe("B");

  await page.evaluate(() => (window as never as { __t: Api }).__t.autoScrollTo(250));

  // Back → A.
  await page.goBack();
  await page.waitForFunction(() => window.scrollY > 600, undefined, { timeout: 5000 });

  const afterBack = await page.evaluate(() => (window as never as { __t: Api }).__t.autoObserved());
  expect(afterBack.y).toBeGreaterThan(600);
  // SibuJS must have done it — with history.scrollRestoration = "manual" the
  // engine will not, and the recorded call proves who moved the viewport.
  expect(afterBack.calls, "no scrollTo was observed — the engine restored, not SibuJS").toContainEqual({
    x: 0,
    y: 900,
  });

  // Forward → B.
  await page.evaluate(() => {
    (window as unknown as { __scrollCalls: unknown[] }).__scrollCalls.length = 0;
  });
  await page.goForward();
  await page.waitForFunction(() => window.scrollY > 100 && window.scrollY < 600, undefined, { timeout: 5000 });

  const afterForward = await page.evaluate(() => (window as never as { __t: Api }).__t.autoObserved());
  expect(afterForward.calls).toContainEqual({ x: 0, y: 250 });

  const positions = await page.evaluate(() => (window as never as { __t: Api }).__t.autoPositions());
  expect(positions.A?.y).toBe(900);
  expect(positions.B?.y).toBe(250);

  // Disposing the last controller hands native restoration back.
  const restored = await page.evaluate(() => (window as never as { __t: Api }).__t.teardownAutoRoundTrip());
  expect(restored).toBe("auto");
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
