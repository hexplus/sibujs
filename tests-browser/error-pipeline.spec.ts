import { expect, test } from "@playwright/test";

// Real-browser validation of the error-routing primitive.
//
// The whole pipeline hinges on DOM semantics that jsdom only emulates: a
// `cancelable` CustomEvent, `preventDefault()` from a boundary listener, and
// the boolean `dispatchEvent()` returns. Those three facts decide whether an
// error is treated as handled, so they are pinned against a real engine rather
// than trusted from an emulation.
//
// Served over HTTP (not file://) because the fixture uses real ES module
// imports from `dist/`.

const PAGE = "/examples/error-pipeline-browser.html";

test.beforeEach(async ({ page }) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
});

test("dispatchEvent() reports preventDefault() as a false return value", async ({ page }) => {
  // If this engine ever stopped honouring cancelation, every "handled" decision
  // in the pipeline would silently invert.
  const returned = await page.evaluate(() => (window as never as { __t: { dispatchClaimed(): boolean } }).__t.dispatchClaimed());
  expect(returned).toBe(false);
});

test("an unclaimed error still reaches the runtime handler", async ({ page }) => {
  const sawEvent = await page.evaluate(() =>
    (window as never as { __t: { dispatchUnclaimed(): boolean } }).__t.dispatchUnclaimed(),
  );
  expect(sawEvent).toBe(true);

  const reports = await page.evaluate(() =>
    (window as never as { __t: { reports(): Array<{ message: string }> } }).__t.reports(),
  );
  // The listener observed the event but never claimed it, so the fallback must
  // have run exactly once — a dispatch is not a handling.
  expect(reports.filter((r) => r.message === "unclaimed-error")).toHaveLength(1);
});

test("a claimed error does NOT reach the runtime handler", async ({ page }) => {
  await page.evaluate(() => (window as never as { __t: { dispatchClaimed(): boolean } }).__t.dispatchClaimed());
  const reports = await page.evaluate(() =>
    (window as never as { __t: { reports(): Array<{ message: string }> } }).__t.reports(),
  );
  expect(reports.filter((r) => r.message === "claimed-error")).toHaveLength(0);
});

test("ErrorBoundary claims a keyed-row render failure and shows its fallback", async ({ page }) => {
  await page.evaluate(() => (window as never as { __t: { mountEachBoundary(): void } }).__t.mountEachBoundary());
  await expect(page.locator("#boundary-each .fb-each")).toHaveText("each recovered");

  const reports = await page.evaluate(() =>
    (window as never as { __t: { reports(): Array<{ message: string }> } }).__t.reports(),
  );
  expect(reports.filter((r) => r.message === "row-exploded")).toHaveLength(0);
});

test("ErrorBoundary claims a binding that throws on a later update", async ({ page }) => {
  await page.evaluate(() => (window as never as { __t: { mountBindingBoundary(): void } }).__t.mountBindingBoundary());
  await page.evaluate(() => (window as never as { __t: { breakBinding(): void } }).__t.breakBinding());

  await expect(page.locator("#boundary-binding .fb-binding")).toHaveText("binding recovered");

  const reports = await page.evaluate(() =>
    (window as never as { __t: { reports(): Array<{ message: string }> } }).__t.reports(),
  );
  expect(reports.filter((r) => r.message === "binding-exploded")).toHaveLength(0);
});

test("sibling boundaries sharing one fallback stay independent", async ({ page }) => {
  // The bug this pins: a global fallback cache keyed by (fallback fn,
  // error.message) handed Boundary B the Error and retry captured by
  // Boundary A. Both boundaries below share one fallback function and fail
  // with the SAME message, so an aliasing regression is immediately visible in
  // the rendered DOM.
  await page.evaluate(() => (window as never as { __t: { mountSiblings(): void } }).__t.mountSiblings());
  await page.evaluate(() => (window as never as { __t: { breakSiblings(): void } }).__t.breakSiblings());

  const ids = await page.locator("#siblings .sib-fb").evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-error-id")),
  );
  expect(ids).toEqual(["A", "B"]);

  // Each fallback's retry control belongs to its own boundary.
  await page.evaluate(() => (window as never as { __t: { healB(): void } }).__t.healB());
  await page.locator('#siblings .sib-retry[data-retry-for="B"]').click();

  await expect(page.locator("#siblings .sib-ok-B")).toHaveText("ok-B");
  // A is untouched: still showing its own fallback, not B's and not recovered.
  const after = await page.locator("#siblings .sib-fb").evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-error-id")),
  );
  expect(after).toEqual(["A"]);
});
