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
  // Read in the same task as the switch: a separate round trip can land after
  // the 200 ms animation on a loaded machine.
  const { switchedAt, panels, unmounted } = await page.evaluate(() => {
    const api = (window as never as { __t: T }).__t;
    const at = api.toggle();
    return { switchedAt: at, panels: api.panels(), unmounted: api.unmounted() };
  });
  expect(panels).toEqual([
    { name: "B", inert: false, hidden: null, leaving: false },
    { name: "A", inert: true, hidden: "true", leaving: true },
  ]);
  expect(unmounted).toEqual([]);

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

test("CSS longhands: one shared duration, two delays — the leave outlasts the delayed property", async ({ page }) => {
  await open(page);
  // Let the initial style settle so adding the class starts both transitions.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const switchedAt = await page.evaluate(() => (window as never as { __t: { longhand: () => number } }).__t.longhand());
  await expect(page.locator("[data-longhand]")).toHaveCount(0, { timeout: 3000 });
  const log = await page.evaluate(
    () =>
      (
        window as never as {
          __t: {
            longhandLog: () => {
              unmountedAt: number;
              ends: { property: string; at: number; connected: boolean }[];
            };
          };
        }
      ).__t.longhandLog(),
  );
  const opacity = log.ends.find((e) => e.property === "opacity");
  // Still in the document when the first property finished (200 ms)...
  expect(opacity, "opacity transitionend").toBeDefined();
  expect(opacity?.connected).toBe(true);
  // ...and removed only once the delayed one had (500 ms delay + 200 ms). The
  // removal follows the transform transition's `finished`, which an engine
  // resolves before it dispatches `transitionend` (and on a loaded machine the
  // computed fallback may come first), so the lifecycle timestamp is the gate.
  expect(log.unmountedAt - switchedAt).toBeGreaterThanOrEqual(650);
});

test("rows an each() rendered into a leaving fragment branch cannot be focused or clicked", async ({ page }) => {
  await open(page);
  await expect(page.locator("[data-row]")).toHaveCount(2);
  const box = await page.locator('[data-row="1"]').boundingBox();
  // Focus a control before the rows, so Tab would walk through them.
  await page.evaluate(() => (document.querySelector("[data-pair]") as HTMLElement).focus());
  await page.evaluate(() => (window as never as { __t: { hideRows: () => void } }).__t.hideRows());

  // Still on screen while the leave plays, inert and carrying the leave class.
  await expect(page.locator("[data-row][inert].slow-out")).toHaveCount(2);

  // A real pointer click on a row does not activate it, Tab never lands on
  // one (every focus change is recorded in the page), and script cannot
  // focus one either.
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  const result = await page.evaluate(() => {
    const t = (window as never as { __t: { clicks: () => number[]; rowFocus: () => string[] } }).__t;
    const row = document.querySelector('[data-row="2"]') as HTMLElement | null;
    row?.focus();
    return {
      stillLeaving: document.querySelectorAll("[data-row][inert]").length,
      scripted: row !== null && document.activeElement === row,
      clicks: t.clicks(),
      rowFocus: t.rowFocus(),
    };
  });
  expect(result.stillLeaving, "the leave ended before the interaction was checked").toBe(2);
  expect(result.scripted).toBe(false);
  expect(result.clicks).toEqual([]);
  expect(result.rowFocus).toEqual([]);

  // The rows leave with the branch.
  await expect(page.locator("[data-row]")).toHaveCount(0, { timeout: 8000 });
});

test("a listed transition-property that never changes does not hold the leave", async ({ page }) => {
  await open(page);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const switchedAt = await page.evaluate(() => (window as never as { __t: { noop: () => number } }).__t.noop());
  await expect(page.locator("[data-noop]")).toHaveCount(0, { timeout: 4000 });
  const unmountedAt = await page.evaluate(
    () => (window as never as { __t: { noopUnmountedAt: () => number } }).__t.noopUnmountedAt(),
  );
  // The opacity transition (200 ms) ran; `color` (3 s) never started.
  expect(unmountedAt - switchedAt).toBeGreaterThanOrEqual(150);
  expect(unmountedAt - switchedAt).toBeLessThan(2000);
});

test("a row added partway through a leave is waited for, not cut off", async ({ page }) => {
  await open(page);
  await expect(page.locator("[data-late]")).toHaveCount(1);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.evaluate(() => (window as never as { __t: { hideThenAddLate: () => void } }).__t.hideThenAddLate());
  await expect(page.locator('[data-late="2"].late-out[inert]')).toHaveCount(1, { timeout: 3000 });
  await expect(page.locator("[data-late]")).toHaveCount(0, { timeout: 6000 });
  const log = await page.evaluate(
    () =>
      (
        window as never as {
          __t: { lateLog: () => { hidden: number; added: number; stillLeaving: boolean; removed: Record<string, number> } };
        }
      ).__t.lateLog(),
  );
  // The row joined while the 1.2 s leave was playing...
  expect(log.stillLeaving).toBe(true);
  // ...and the branch was removed only once the late row's own 1.2 s
  // animation had run, not when the first row's ended (~900 ms earlier).
  expect(log.removed["2"] - log.added).toBeGreaterThanOrEqual(1100);
  expect(log.removed["1"] - log.hidden).toBeGreaterThanOrEqual(log.added - log.hidden + 1100);
});

test("rows a top-level each() renders enter with their branch", async ({ page }) => {
  await open(page);
  await page.evaluate(() => (window as never as { __t: { showEnter: () => void } }).__t.showEnter());
  await expect(page.locator("[data-enter]")).toHaveCount(2);
  await expect
    .poll(() =>
      page.evaluate(() => (window as never as { __t: { entered: () => { row: string; name: string }[] } }).__t.entered()),
    )
    .toEqual(
      expect.arrayContaining([
        { row: "1", name: "rise" },
        { row: "2", name: "rise" },
      ]),
    );
  await expect(page.locator(".row-in")).toHaveCount(0, { timeout: 3000 });
});

type AsyncApi = {
  suspHide: () => void;
  suspResolve: () => void;
  suspLog: () => { loadedSeen: boolean; fallbackCleanups: number; removedAt: number; text: string };
  nestedSelectThenClear: () => void;
  nestedSelect: () => void;
  nestedEntered: () => string[];
};
const api = <K extends keyof AsyncApi>(page: Page, key: K) =>
  page.evaluate((k) => (window as never as { __t: AsyncApi }).__t[k as K]() as ReturnType<AsyncApi[K]>, key);

test("Suspense content resolving during the leave never replaces the fallback", async ({ page }) => {
  await open(page);
  await expect(page.locator("[data-fallback]")).toHaveCount(1);
  await api(page, "suspHide");
  await expect(page.locator("[data-susp].slow-out[inert]")).toHaveCount(1);
  await api(page, "suspResolve");
  await page.waitForTimeout(100);
  let log = await api(page, "suspLog");
  expect(log.text).toBe("loading");
  expect(log.loadedSeen).toBe(false);
  expect(log.fallbackCleanups).toBe(0);
  // Released with the branch, once.
  await expect(page.locator("[data-susp]")).toHaveCount(0, { timeout: 8000 });
  log = await api(page, "suspLog");
  expect(log.loadedSeen).toBe(false);
  expect(log.fallbackCleanups).toBe(1);
});

test("a nested enter waiting on rows does not start once its ancestor froze", async ({ page }) => {
  await open(page);
  await api(page, "nestedSelectThenClear");
  await expect(page.locator("[data-nested].slow-out[inert]")).toHaveCount(1);
  await page.waitForTimeout(100);
  expect(await api(page, "nestedEntered")).toEqual([]);
  await expect(page.locator("[data-nested]")).toHaveCount(0, { timeout: 8000 });
  expect(await api(page, "nestedEntered")).toEqual([]);
  // A live one still enters, once.
  await api(page, "nestedSelect");
  await expect.poll(() => api(page, "nestedEntered")).toEqual(["Ada"]);
});

test("a branch taken back mid-leave adopts the Suspense content that resolved while it was paused", async ({ page }) => {
  await open(page);
  const call = (name: string) =>
    page.evaluate((n) => (window as never as { __t: Record<string, () => unknown> }).__t[n](), name);
  await expect(page.locator("[data-reclaim]")).toHaveText("waiting");
  await call("reclaimHide");
  await expect(page.locator("[data-reclaim].slow-out[inert]")).toHaveCount(1);
  await call("reclaimResolve");
  await page.waitForTimeout(100);
  // Paused: the fallback stays, the content is not shown.
  await expect(page.locator("[data-reclaim]")).toHaveText("waiting");
  await expect(page.locator("[data-reclaimed]")).toHaveCount(0);
  await call("reclaimShow");
  // Taken back: interactive again, and the held content is adopted once.
  await expect(page.locator("[data-reclaim]:not([inert]):not(.slow-out)")).toHaveCount(1);
  await expect(page.locator("[data-reclaimed]")).toHaveCount(1);
  await expect(page.locator("[data-reclaim]")).toHaveText("content");
  expect(await call("reclaimLog")).toEqual({ nodesCalls: 1 });
});
