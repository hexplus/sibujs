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

test("a reset key changing while healthy does not auto-clear a later failure", async ({ page }) => {
  // resetKeys are triggers, not subscriptions. Reading the boundary's error
  // reactively inside the reset watcher made the watcher a subscriber of
  // setError() from the first key change onward, so a later unrelated failure
  // re-ran the watcher and retried itself — the fallback vanished instantly.
  await page.evaluate(() => (window as never as { __t: { mountResetKeys(): void } }).__t.mountResetKeys());
  await expect(page.locator("#resetkeys .rk-content")).toHaveText("ok");

  // Key changes while the boundary is healthy.
  await page.evaluate(() => (window as never as { __t: { rkChangeKey(v: string): void } }).__t.rkChangeKey("b"));
  await expect(page.locator("#resetkeys .rk-fallback")).toHaveCount(0);

  // Later failure, with NO further key change: the fallback must persist.
  await page.evaluate(() => (window as never as { __t: { rkFail(): void } }).__t.rkFail());
  await expect(page.locator("#resetkeys .rk-fallback")).toHaveText("failed");

  // And a genuine key change still recovers it.
  await page.evaluate(() => (window as never as { __t: { rkHeal(): void } }).__t.rkHeal());
  await page.evaluate(() => (window as never as { __t: { rkChangeKey(v: string): void } }).__t.rkChangeKey("c"));
  await expect(page.locator("#resetkeys .rk-content")).toHaveText("ok");
});

test("a selector reset key ignores object replacement that leaves its value equal", async ({ page }) => {
  // resetKeys are VALUES. `() => route().pathname` re-runs whenever the route
  // object is replaced, but only a genuine change of the selected string may
  // recover a failed boundary — otherwise any unrelated field write silently
  // dismisses the error UI.
  await page.evaluate(() => (window as never as { __t: { mountSelectorResetKey(): void } }).__t.mountSelectorResetKey());
  await expect(page.locator("#rk-selector .sel-content")).toHaveText("ok");

  await page.evaluate(() => (window as never as { __t: { selFail(): void } }).__t.selFail());
  await expect(page.locator("#rk-selector .sel-fallback")).toHaveText("failed");

  // Object replaced, pathname unchanged -> stays failed.
  await page.evaluate(() => (window as never as { __t: { selHeal(): void } }).__t.selHeal());
  await page.evaluate(() => (window as never as { __t: { selReplaceSamePath(): void } }).__t.selReplaceSamePath());
  await expect(page.locator("#rk-selector .sel-fallback")).toHaveText("failed");

  // Selected value genuinely changes -> recovers.
  await page.evaluate(() => (window as never as { __t: { selChangePath(): void } }).__t.selChangePath());
  await expect(page.locator("#rk-selector .sel-content")).toHaveText("ok");
});
