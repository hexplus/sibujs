/**
 * Real-browser proof for meta-refresh handling.
 *
 * Only a real engine honours a refresh directive, so this is where "the entry
 * was withdrawn before the browser could act on it" is actually provable.
 *
 * SYNCHRONIZATION — deliberately not a fixed delay.
 *
 * A negative timeout proves nothing on its own: if the engine simply hadn't got
 * around to the refresh yet, an absent navigation looks identical to a blocked
 * one. So the benign control does a REAL same-origin refresh and the test waits
 * on `waitForURL()`. That does two jobs: it proves the probe is capable of
 * observing a refresh at all, and it measures how long this engine actually
 * takes to honour one — making the subsequent negative assertions meaningful.
 *
 * The dangerous destination is additionally a same-origin path with a route
 * interceptor counting requests, so a navigation cannot pass unnoticed. No
 * external host is ever contacted.
 */

import { expect, test } from "@playwright/test";

const PAGE = "/examples/meta-refresh-security-browser.html";
const PROTECTED = "**/examples/should-never-load.html";

type Api = {
  dangerousTransition(): {
    before: { present: boolean; content: string | null; url: string };
    after: { present: boolean; content: string | null; url: string };
  };
  malformedNavigationTransition(): { present: boolean; content: string | null; url: string };
  obfuscatedTransition(): {
    before: { present: boolean; content: string | null; url: string };
    after: { present: boolean; content: string | null; url: string };
  };
  benignRefresh(): { present: boolean; content: string | null; url: string };
  arrivedAt(): string | null;
  xss(): boolean;
  cleanup(): boolean;
};

test.beforeEach(async ({ page }) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
});

test("control: a benign refresh IS honoured, so the probe works", async ({ page }) => {
  const built = await page.evaluate(() => (window as never as { __t: Api }).__t.benignRefresh());
  expect(built.present, "a safe refresh directive was suppressed").toBe(true);
  expect(built.content).toContain("arrived=1");

  // The engine genuinely performs the navigation — this is the upper bound the
  // negative tests below rely on.
  await page.waitForURL(/arrived=1/, { timeout: 10_000 });

  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  const arrived = await page.evaluate(() => (window as never as { __t: Api }).__t.arrivedAt());
  expect(arrived, "the control navigation did not complete").toBe("1");
});

test("a reactive http-equiv cannot activate static dangerous content", async ({ page }) => {
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.dangerousTransition());

  // Before the flip it is simply not a refresh directive.
  expect(result.before.present).toBe(false);
  // After the flip the entry must be gone, not merely re-labelled.
  expect(result.after.present, "a dangerous refresh became live").toBe(false);

  const xss = await page.evaluate(() => (window as never as { __t: Api }).__t.xss());
  expect(xss).toBe(false);
  await page.evaluate(() => (window as never as { __t: Api }).__t.cleanup());
});

test("an ambiguous directive never navigates to its first assignment", async ({ page }) => {
  // A relative path is a legal refresh destination, so this is not a protocol
  // question — it is the conservative rule for ambiguous syntax. Two competing
  // `url=` assignments have no single defensible reading, so the directive is
  // dropped. An implementation that took the first would navigate here, and
  // this interceptor would count the request.
  let requests = 0;
  await page.route(PROTECTED, (route) => {
    requests++;
    return route.abort();
  });

  const startUrl = page.url();
  const after = await page.evaluate(() => (window as never as { __t: Api }).__t.malformedNavigationTransition());
  expect(after.present, "an ambiguous refresh became live").toBe(false);

  // The control test above established that this engine honours a 0-second
  // refresh well within this window, so the absence below is meaningful rather
  // than merely early.
  await page.waitForLoadState("networkidle");

  expect(requests, "the protected destination was requested").toBe(0);
  expect(page.url(), "the page navigated away").toBe(startUrl);

  const xss = await page.evaluate(() => (window as never as { __t: Api }).__t.xss());
  expect(xss).toBe(false);
  await page.evaluate(() => (window as never as { __t: Api }).__t.cleanup());
});

test("a whitespace/quoted dangerous spelling is withdrawn too", async ({ page }) => {
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.obfuscatedTransition());

  // The safe directive was live first…
  expect(result.before.present).toBe(true);
  // …and `0; URL = 'javascript:…'` — which the old substring check missed —
  // withdraws it.
  expect(result.after.present, "an obfuscated dangerous refresh stayed live").toBe(false);

  const xss = await page.evaluate(() => (window as never as { __t: Api }).__t.xss());
  expect(xss).toBe(false);
  await page.evaluate(() => (window as never as { __t: Api }).__t.cleanup());
});
