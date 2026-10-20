/**
 * `embed()` never grants a permission its caller restricted — checked against
 * a real engine's container policy.
 *
 * `allow` is narrowed to player features and rewritten as bare feature names,
 * which grant the frame's own origin. That is a narrowing for `fullscreen *`
 * but would be a grant for `fullscreen 'none'`, `fullscreen 'self'` or a list
 * of other origins, so those features are dropped instead. jsdom has no
 * permissions policy; Chromium exposes the effective container policy through
 * `HTMLIFrameElement.featurePolicy.allowsFeature()`, so each case compares the
 * frame `embed()` built with a raw frame carrying the caller's exact `allow`:
 * every feature the built frame grants, the raw one must grant too.
 *
 * Other engines do not expose the container policy; there the narrowed
 * attribute value is still asserted.
 */

import { expect, type Page, test } from "@playwright/test";

const PAGE = "/examples/embed-permissions-browser.html";

type Grants = Record<string, boolean>;
type Comparison = { narrowed: string | null; allowfullscreen: boolean; requested: Grants; effective: Grants };
type Api = { hasFeaturePolicy(): boolean; compare(allow: string): Comparison };

const CASES: Array<[allow: string, narrowed: string | null]> = [
  ["fullscreen 'none'", null],
  ["autoplay 'none'", null],
  ["fullscreen https://other.example", null],
  ["fullscreen 'self'", null],
  ["fullscreen *", "fullscreen"],
  ["fullscreen 'src'", "fullscreen"],
  ["camera; fullscreen", "fullscreen"],
  ["fullscreen 'none'; fullscreen", null],
  ["fullscreen; fullscreen 'none'", null],
  ["autoplay; encrypted-media; picture-in-picture; microphone", "autoplay; encrypted-media; picture-in-picture"],
];

async function open(page: Page) {
  // The frames point at a host that does not exist; answer it locally so no
  // navigation leaves the machine.
  await page.route("https://player.example/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><body>" }),
  );
  await page.goto(PAGE);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
}

for (const [allow, narrowed] of CASES) {
  test(`allow ${JSON.stringify(allow)} is narrowed, never widened`, async ({ page }) => {
    await open(page);
    const result = await page.evaluate((a) => (window as never as { __t: Api }).__t.compare(a), allow);
    expect(result.narrowed).toBe(narrowed);
    expect(result.allowfullscreen).toBe((narrowed ?? "").split("; ").includes("fullscreen"));

    const hasPolicy = await page.evaluate(() => (window as never as { __t: Api }).__t.hasFeaturePolicy());
    if (!hasPolicy) return;
    for (const [feature, granted] of Object.entries(result.effective)) {
      if (granted) expect(result.requested[feature], `${feature} granted beyond the request`).toBe(true);
    }
  });
}

test("the probe sees real grants (Chromium)", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "only Chromium exposes HTMLIFrameElement.featurePolicy");
  await open(page);
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.compare("fullscreen; autoplay"));
  // Without this, "never widened" could pass because nothing is ever granted.
  expect(result.effective.fullscreen).toBe(true);
  expect(result.effective.autoplay).toBe(true);
  expect(result.effective.camera).toBe(false);
});
