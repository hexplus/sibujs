/**
 * Real-browser validation of lifecycle ownership and enter readiness —
 * Chromium, Firefox, WebKit.
 *
 * The jsdom suites (`tests/lifecycle-ownership.test.ts`,
 * `tests/directive-enter-readiness.test.ts`) are the exhaustive ones. This
 * file checks, on real engines with real CSS animations and real microtask
 * ordering:
 *
 * - a lazy route whose module resolves while its branch is paused invokes no
 *   factory through repeated reclaims that pause it again, and is built once
 *   when the branch is taken back for good; work it registered after an
 *   `await` through `lifecycleScope()` pauses and catches up with it;
 * - content that loads while its branch enters joins the enter
 *   (`waitForContent`), which ends with that content's animation;
 * - content that never loads ends the enter at its deadline.
 */
import { expect, type Page, test } from "@playwright/test";

const FIXTURE = "/examples/lifecycle-ownership-browser.html";

const call = <R = unknown>(page: Page, name: string, arg?: unknown) =>
  page.evaluate(
    ([n, a]) => (window as never as { __t: Record<string, (x?: unknown) => unknown> }).__t[n as string](a),
    [name, arg] as const,
  ) as Promise<R>;

interface RouteLog {
  factoryCalls: number;
  bindingRuns: number;
  effectRuns: number;
  states: string[];
  scope: string | null;
  pages: number;
  text: string | null;
}
interface Timeline {
  shownAt: number;
  resolvedAt: number;
  contentStart: number;
  contentEnd: number;
  enterEnd: number;
  contentClassed: boolean;
  contents?: number;
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true);
});

test("a lazy route resolving in a paused branch is built once, only when the branch is active", async ({ page }) => {
  await call(page, "routeHide");
  await expect(page.locator("[data-route-branch].slow-out[inert]")).toHaveCount(1);
  await call(page, "routeResolve");
  await page.waitForTimeout(100);
  expect((await call<RouteLog>(page, "routeLog")).factoryCalls).toBe(0);

  // Taken back, then paused again before the factory call the resume woke
  // could run: still not invoked, every time.
  for (let i = 0; i < 3; i++) {
    await call(page, "routeReclaimThenPause");
    await page.waitForTimeout(60);
    const log = await call<RouteLog>(page, "routeLog");
    expect(log.factoryCalls).toBe(0);
    expect(log.pages).toBe(0);
  }
  await expect(page.locator("[data-route-branch].slow-out[inert]")).toHaveCount(1);

  await call(page, "routeShow");
  await expect(page.locator("[data-page]")).toHaveCount(1);
  let log = await call<RouteLog>(page, "routeLog");
  expect(log.factoryCalls).toBe(1);
  expect(log.states).toEqual(["active"]);
  expect(log.text).toBe("a");
  expect(log.effectRuns).toBe(1);

  // Its lifecycle pauses with the branch: neither its binding nor the effect
  // it registered after an await reacts, and both catch up once on resume.
  await call(page, "routeHide");
  await expect(page.locator("[data-route-branch].slow-out[inert]")).toHaveCount(1);
  const before = await call<RouteLog>(page, "routeLog");
  expect(before.scope).toBe("paused");
  await call(page, "routeLabel", "b");
  await call(page, "routeLabel", "c");
  await page.waitForTimeout(50);
  log = await call<RouteLog>(page, "routeLog");
  expect(log.bindingRuns).toBe(before.bindingRuns);
  expect(log.effectRuns).toBe(before.effectRuns);
  expect(log.text).toBe("a");
  await call(page, "routeShow");
  await expect(page.locator("[data-page]")).toHaveText("c");
  log = await call<RouteLog>(page, "routeLog");
  expect(log.bindingRuns).toBe(before.bindingRuns + 1);
  expect(log.effectRuns).toBe(before.effectRuns + 1);
  expect(log.scope).toBe("active");
  expect(log.factoryCalls).toBe(1);
});

test("content that loads during the enter joins it; the enter ends with its animation", async ({ page }) => {
  // The heading's own enter runs 300 ms; the content resolves 150 ms in.
  await call(page, "readyShow", 150);
  await expect.poll(async () => (await call<Timeline>(page, "readyLog")).enterEnd, { timeout: 5000 }).toBeGreaterThan(0);
  const t = await call<Timeline>(page, "readyLog");
  expect(t.contentClassed).toBe(true);
  // The content's animation really ran, after it arrived...
  expect(t.contentStart).toBeGreaterThanOrEqual(t.resolvedAt);
  expect(t.contentEnd).toBeGreaterThan(t.contentStart);
  // ...and the enter ended with it, not with the heading's 300 ms.
  expect(t.enterEnd).toBeGreaterThanOrEqual(t.contentEnd - 20);
  expect(t.enterEnd - t.shownAt).toBeGreaterThan(400);
  expect(t.enterEnd - t.shownAt).toBeLessThan(3000);
});

test("content that never loads ends the enter at its deadline", async ({ page }) => {
  await call(page, "neverShow");
  await expect.poll(async () => (await call<Timeline>(page, "neverLog")).enterEnd, { timeout: 5000 }).toBeGreaterThan(0);
  const t = await call<Timeline>(page, "neverLog");
  // `waitForContent: 600`: open past the heading's 300 ms, closed at ~600 ms.
  expect(t.enterEnd - t.shownAt).toBeGreaterThanOrEqual(550);
  expect(t.enterEnd - t.shownAt).toBeLessThan(2000);
  expect(t.contents).toBe(0);
});
