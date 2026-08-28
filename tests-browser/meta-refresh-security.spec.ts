/**
 * Real-browser proof for meta-refresh handling.
 *
 * WHAT CAN AND CANNOT BE PROVEN HERE
 * ----------------------------------
 * A browser processes a meta refresh when the element is INSERTED — it records
 * the pending navigation at that moment. Removing the element afterwards is not
 * a defined cancellation mechanism, so "the element is gone now" proves nothing
 * about whether a navigation is still coming. An earlier version of this file
 * asserted exactly that, and it was not a sound claim.
 *
 * So the contract under test is the stronger, checkable one: a forbidden or
 * reactive refresh element is NEVER CONNECTED in the first place. The fixture
 * records the state of every connected `<meta>` after each DOM mutation, which
 * is the complete trace of observable states — read synchronously, with no
 * timing assumptions.
 *
 * NAVIGATION IS PROVEN PER TEST, NOT BORROWED FROM ANOTHER ONE
 * -----------------------------------------------------------
 * A negative timeout is worthless on its own: an engine that simply hasn't got
 * around to a refresh yet looks identical to one that was never given a
 * directive. Each negative test therefore ends by publishing a real, static,
 * same-origin refresh of its own and waiting for that navigation to land. Once
 * it has, the engine demonstrably acted on a refresh during this page instance,
 * so a protected-path request count of zero means "never scheduled" rather than
 * "not yet". No test depends on another test having run, and there are no
 * arbitrary waits.
 *
 * Every destination is same-origin, and the protected path is intercepted and
 * counted in every test that could reach it. No external host is contacted.
 */

import { expect, type Page, test } from "@playwright/test";

const PAGE = "/examples/meta-refresh-security-browser.html";
const PROTECTED = "**/examples/should-never-load.html*";

interface Observation {
  httpEquiv: string | null;
  content: string | null;
  name: string | null;
}

interface Snapshot {
  present: boolean;
  content: string | null;
  url: string;
}

interface Api {
  reset(): boolean;
  trace(): Observation[];
  connectedRefreshStates(): Observation[];
  atomicTransition(): { before: Snapshot; after: Snapshot };
  reactiveRefreshFlip(): { before: Snapshot; after: Snapshot };
  reactiveContentRefresh(): { before: Snapshot; after: Snapshot };
  reactiveRefreshThenOrdinary(): {
    before: Snapshot;
    after: Snapshot;
    ordinaryPublished: boolean;
    ordinaryContent: string | null;
  };
  staticForbiddenRefresh(): Snapshot;
  staticMalformedRefresh(): Snapshot;
  duplicateCasingRefresh(): Snapshot;
  staticSafeRefresh(tag: string): Snapshot;
  arrivedAt(): string | null;
  xss(): boolean;
}

/** Count every request to the protected path, and let none of them complete. */
async function protectPath(page: Page): Promise<() => number> {
  let requests = 0;
  await page.route(PROTECTED, (route) => {
    requests++;
    return route.abort();
  });
  return () => requests;
}

/**
 * Publish a real static refresh and wait for it to land.
 *
 * This is the per-test bound. Until it returns, "no navigation happened" is
 * merely a statement about how fast the test ran; afterwards it is a statement
 * about the engine, which has just demonstrated it acts on refresh directives
 * here and now.
 */
async function proveEngineHonoursRefresh(page: Page, tag: string): Promise<void> {
  const published = await page.evaluate((t) => (window as never as { __t: Api }).__t.staticSafeRefresh(t), tag);
  expect(published.present, "the static control refresh was itself suppressed").toBe(true);

  await page.waitForURL(new RegExp(`arrived=${tag}`), { timeout: 10_000 });
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  const arrived = await page.evaluate(() => (window as never as { __t: Api }).__t.arrivedAt());
  expect(arrived, "the control navigation did not complete").toBe(tag);
}

test.beforeEach(async ({ page }) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await page.evaluate(() => (window as never as { __t: Api }).__t.reset());
});

test("control: a static safe refresh IS honoured, so the probe works", async ({ page }) => {
  // The positive control. Without it, every negative assertion below could be
  // satisfied by a page that simply cannot refresh at all.
  await proveEngineHonoursRefresh(page, "control");
});

test("an atomic transition never connects the old content beside the new http-equiv", async ({ page }) => {
  // Finding 1. One state update carries both fields and the resulting snapshot
  // is entirely valid — the danger was purely in how the change was applied.
  const requests = await protectPath(page);

  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.atomicTransition());
  expect(result.before.present).toBe(false);
  expect(result.after.present).toBe(false);

  // The synchronous, complete trace: no connected element ever carried a
  // refresh directive at all, let alone the forbidden pair.
  const refreshStates = await page.evaluate(() => (window as never as { __t: Api }).__t.connectedRefreshStates());
  expect(refreshStates, "a refresh directive was connected during the transition").toEqual([]);

  expect(await page.evaluate(() => (window as never as { __t: Api }).__t.xss())).toBe(false);

  await proveEngineHonoursRefresh(page, "atomic");
  expect(requests(), "the protected destination was requested").toBe(0);
});

test("a reactive http-equiv never publishes a refresh, even to a safe destination", async ({ page }) => {
  const requests = await protectPath(page);

  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.reactiveRefreshFlip());
  expect(result.before.present).toBe(false);
  // The destination is a legal same-origin path. It is withheld because the
  // framework could not withdraw the scheduled navigation if the state changed
  // back — reversibility, not safety.
  expect(result.after.present, "a reactive entry published a native refresh").toBe(false);

  const refreshStates = await page.evaluate(() => (window as never as { __t: Api }).__t.connectedRefreshStates());
  expect(refreshStates).toEqual([]);

  await proveEngineHonoursRefresh(page, "reactiveflip");
  expect(requests(), "a withheld reactive refresh still navigated").toBe(0);
});

test("a static refresh with reactive content never publishes one either", async ({ page }) => {
  const requests = await protectPath(page);

  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.reactiveContentRefresh());
  expect(result.before.present, "a reactive-content refresh was published on first render").toBe(false);
  expect(result.after.present).toBe(false);

  const refreshStates = await page.evaluate(() => (window as never as { __t: Api }).__t.connectedRefreshStates());
  expect(refreshStates).toEqual([]);

  await proveEngineHonoursRefresh(page, "reactivecontent");
  expect(requests()).toBe(0);
});

test("a reactive refresh that becomes an ordinary meta publishes the ordinary one", async ({ page }) => {
  const requests = await protectPath(page);

  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.reactiveRefreshThenOrdinary());
  expect(result.before.present).toBe(false);
  expect(result.after.present).toBe(false);

  // The rule is narrow: it withholds refresh directives, not reactive metadata.
  expect(result.ordinaryPublished, "an ordinary reactive http-equiv entry was suppressed").toBe(true);
  expect(result.ordinaryContent).toContain("should-never-load");

  const refreshStates = await page.evaluate(() => (window as never as { __t: Api }).__t.connectedRefreshStates());
  expect(refreshStates).toEqual([]);

  await proveEngineHonoursRefresh(page, "thenordinary");
  // The path appears as ordinary `content` text on a non-refresh meta, which is
  // inert — no request may result from it.
  expect(requests(), "an inert content string caused a request").toBe(0);
});

test("a static forbidden refresh is never connected", async ({ page }) => {
  const after = await page.evaluate(() => (window as never as { __t: Api }).__t.staticForbiddenRefresh());
  expect(after.present, "a javascript: refresh became live").toBe(false);

  const refreshStates = await page.evaluate(() => (window as never as { __t: Api }).__t.connectedRefreshStates());
  expect(refreshStates).toEqual([]);
  expect(await page.evaluate(() => (window as never as { __t: Api }).__t.xss())).toBe(false);

  await proveEngineHonoursRefresh(page, "forbidden");
  expect(await page.evaluate(() => (window as never as { __t: Api }).__t.xss())).toBe(false);
});

test("an ambiguous static directive never navigates to its first assignment", async ({ page }) => {
  const requests = await protectPath(page);

  const after = await page.evaluate(() => (window as never as { __t: Api }).__t.staticMalformedRefresh());
  expect(after.present, "an ambiguous refresh became live").toBe(false);

  const refreshStates = await page.evaluate(() => (window as never as { __t: Api }).__t.connectedRefreshStates());
  expect(refreshStates).toEqual([]);

  await proveEngineHonoursRefresh(page, "ambiguous");
  // An implementation that read the first `url=` would have navigated here, and
  // the engine has now demonstrably had its chance.
  expect(requests(), "the protected destination was requested").toBe(0);
  expect(await page.evaluate(() => (window as never as { __t: Api }).__t.xss())).toBe(false);
});

test("a duplicate-casing entry is never connected", async ({ page }) => {
  const requests = await protectPath(page);

  const after = await page.evaluate(() => (window as never as { __t: Api }).__t.duplicateCasingRefresh());
  expect(after.present, "a duplicate-casing entry was published").toBe(false);

  // Not merely "no refresh" — the entry as a whole is refused, so nothing from
  // it reaches the document under either spelling.
  const trace = await page.evaluate(() => (window as never as { __t: Api }).__t.trace());
  expect(
    trace.filter((o) => o.httpEquiv !== null),
    "part of a rejected entry was connected",
  ).toEqual([]);

  await proveEngineHonoursRefresh(page, "duplicate");
  expect(requests()).toBe(0);
});
