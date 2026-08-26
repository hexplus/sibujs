/**
 * Real-browser KeepAliveRoute ownership validation — Chromium, Firefox, WebKit.
 *
 * The jsdom suite (`tests/router-hardening-keepalive.test.ts`) is the exhaustive
 * one. This file exists because the races it covers depend on real microtask
 * ordering around a genuine dynamic module boundary and real `history` /
 * `MutationObserver` implementations. Running the two headline races on three
 * engines is what turns "correct under jsdom's scheduler" into "correct".
 *
 * The invariant under test is the same one:
 *
 *   Once superseded, a KeepAlive update generation may never commit — regardless
 *   of whether its route *value* still matches the current location.
 */
import { expect, test } from "@playwright/test";

const FIXTURE = "/examples/keepalive-browser.html";

type KA = {
  navigate: (to: string) => Promise<unknown>;
  resolve: (name: string) => void;
  attached: () => string[];
  mounted: () => string[];
  path: () => string;
};

const ka = (page: import("@playwright/test").Page) => ({
  navigate: (to: string) =>
    page.evaluate((t) => (window as never as { __ka: KA }).__ka.navigate(t).catch(() => {}), to),
  resolve: (name: string) => page.evaluate((n) => (window as never as { __ka: KA }).__ka.resolve(n), name),
  attached: () => page.evaluate(() => (window as never as { __ka: KA }).__ka.attached()),
  mounted: () => page.evaluate(() => (window as never as { __ka: KA }).__ka.mounted()),
  path: () => page.evaluate(() => (window as never as { __ka: KA }).__ka.path()),
});

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true);
});

test("a lazy load superseded by a query-only navigation never commits", async ({ page }) => {
  const k = ka(page);

  // Generation 1 parks on the lazy chunk.
  await k.navigate("/search?q=a");
  // Generation 2 supersedes it. Identical pathname — only the query differs, so
  // a pathname-equality check cannot tell the two apart.
  await k.navigate("/search?q=b");

  // Only now does the chunk arrive, for both parked generations.
  await k.resolve("search");
  await page.waitForFunction(
    () => (window as never as { __ka: KA }).__ka.mounted().length > 0,
    undefined,
    { timeout: 5000 },
  );

  expect(await k.path()).toBe("/search?q=b");

  // Exactly one instance was ever attached, and exactly one is mounted.
  expect(await k.attached()).toHaveLength(1);
  expect(await k.mounted()).toHaveLength(1);
});

test("an A -> B -> A round trip is a new generation, and the stale A loses", async ({ page }) => {
  const k = ka(page);

  await k.navigate("/a"); // A₁ — parks
  await k.navigate("/b"); // B₂ — parks
  await k.resolve("b"); // B₂ commits
  await page.waitForFunction(
    () => (window as never as { __ka: KA }).__ka.mounted().some((id) => id.startsWith("b-")),
    undefined,
    { timeout: 5000 },
  );

  await k.navigate("/a"); // A₃ — same route value, new generation
  await k.resolve("a"); // both A₁ and A₃ resume here

  await page.waitForFunction(
    () => (window as never as { __ka: KA }).__ka.mounted().some((id) => id.startsWith("a-")),
    undefined,
    { timeout: 5000 },
  );

  // B rendered while A was in flight, and A₃ — not A₁ — took the outlet back.
  const attached = await k.attached();
  expect(attached).toHaveLength(2);
  expect(attached[0]).toMatch(/^b-/);
  expect(attached[1]).toMatch(/^a-/);

  // One view mounted, never two.
  const mounted = await k.mounted();
  expect(mounted).toHaveLength(1);
  expect(mounted[0]).toMatch(/^a-/);
});
