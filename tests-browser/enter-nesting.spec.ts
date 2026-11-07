/**
 * Real-browser validation of enter readiness and nesting — Chromium, Firefox,
 * WebKit, with real CSS animations and real timestamps:
 *
 * - content committed inside an element whose enter animation (opacity +
 *   transform) is still running does not get a second copy of it: its own
 *   computed opacity and transform stay at rest, so on screen it moves and
 *   fades exactly with its ancestor, never twice as far or squared;
 * - content committed after that animation finished, while the enter is
 *   still open for it, enters on its own;
 * - an inner `Suspense` revealed by the outer one keeps the enter open, and
 *   the enter ends with the inner content's animation.
 */
import { expect, type Page, test } from "@playwright/test";

const FIXTURE = "/examples/enter-nesting-browser.html";

const call = <R = unknown>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(
    ([n, a]) =>
      (window as never as { __t: Record<string, (...x: unknown[]) => unknown> }).__t[n as string](
        ...(a as unknown[]),
      ),
    [name, args] as const,
  ) as Promise<R>;

interface Sample {
  at: number;
  contentAnimations: number;
  contentClassed: boolean;
  contentOpacity: number;
  contentTransform: string;
  cardAnimations: number;
  cardOpacity: number;
  offset: number;
}
interface CardLog {
  shownAt: number;
  committedAt: number;
  sample: Sample | null;
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true);
});

test("content committed inside an element that is still entering moves and fades with it, once", async ({
  page,
}) => {
  await call(page, "coveredShow");
  await expect.poll(async () => (await call<CardLog>(page, "coveredLog")).sample, { timeout: 5000 }).not.toBeNull();
  const { sample, committedAt, shownAt } = await call<CardLog>(page, "coveredLog");
  const s = sample as Sample;
  expect(committedAt - shownAt).toBeLessThan(800); // committed while the card animates
  // The card is mid-animation: partly transparent.
  expect(s.cardAnimations).toBe(1);
  expect(s.cardOpacity).toBeGreaterThan(0);
  expect(s.cardOpacity).toBeLessThan(1);
  // The content runs no animation of its own: at rest, so its effective
  // opacity is the card's (not the card's times its own) and it sits where
  // its region puts it (no extra translate on top of the card's).
  expect(s.contentClassed).toBe(false);
  expect(s.contentAnimations).toBe(0);
  expect(s.contentOpacity).toBe(1);
  expect(s.contentTransform).toBe("none");
  expect(Math.abs(s.offset)).toBeLessThan(1);
});

test("content committed after its ancestor's animation finished enters on its own", async ({ page }) => {
  await call(page, "lateShow");
  await expect.poll(async () => (await call<CardLog>(page, "lateLog")).sample, { timeout: 5000 }).not.toBeNull();
  const { sample, committedAt, shownAt } = await call<CardLog>(page, "lateLog");
  const s = sample as Sample;
  expect(committedAt - shownAt).toBeGreaterThan(800);
  // The card has finished: fully opaque, nothing running on it.
  expect(s.cardAnimations).toBe(0);
  expect(s.cardOpacity).toBe(1);
  // The content plays the enter itself — the only animation on screen.
  expect(s.contentClassed).toBe(true);
  expect(s.contentAnimations).toBe(1);
  expect(s.contentOpacity).toBeLessThan(1);
  expect(s.contentTransform).not.toBe("none");
  expect(s.offset).toBeGreaterThan(1);
});

test("an inner boundary revealed by the outer content keeps the enter open; the enter ends with it", async ({
  page,
}) => {
  await call(page, "nestedShow", 100, 600);
  await expect
    .poll(async () => (await call<{ enterEnd: number }>(page, "nestedLog")).enterEnd, { timeout: 5000 })
    .toBeGreaterThan(0);
  const t = await call<{
    shownAt: number;
    innerAt: number;
    innerStart: number;
    innerEnd: number;
    enterEnd: number;
    innerClassed: boolean;
  }>(page, "nestedLog");
  expect(t.innerClassed).toBe(true);
  expect(t.innerStart).toBeGreaterThanOrEqual(t.innerAt);
  expect(t.innerEnd).toBeGreaterThan(t.innerStart);
  // Ended with the inner content's animation, not with the outer content's.
  expect(t.enterEnd).toBeGreaterThanOrEqual(t.innerEnd - 20);
  expect(t.enterEnd - t.shownAt).toBeGreaterThan(800);
  expect(t.enterEnd - t.shownAt).toBeLessThan(2500);
});
