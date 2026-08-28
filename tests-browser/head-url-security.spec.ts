/**
 * Real-browser proof for `Head()` URL-attribute security.
 *
 * WHY THIS CANNOT BE A JSDOM TEST
 * ------------------------------
 * jsdom never fetches a `<script src>` and never applies a stylesheet, so it can
 * only check that a dangerous value was not written. "…and it did not EXECUTE"
 * needs a real engine.
 *
 * The exploit was real. `head.ts` classified URL sinks with a case-SENSITIVE set
 * tested against the AUTHORED spelling:
 *
 *     const HEAD_URL_ATTRS = new Set(["href", "src"]);
 *     if (HEAD_URL_ATTRS.has(key)) return sanitizeUrl(value);
 *
 * HTML attribute names are ASCII case-insensitive, so `SRC` reaches the parser
 * as `src`. `Head({ script: [{ SRC: "data:text/javascript,…" }] })` therefore
 * skipped sanitization completely and appended a live `<script>` the browser
 * fetched and ran — while both SSR paths refused the identical value.
 *
 * SYNCHRONIZATION
 * ---------------
 * Every negative assertion is paired with a POSITIVE CONTROL in the same test:
 * a safe same-origin script that must run, or a safe same-origin stylesheet that
 * must apply. Until the control has fired, "the payload did not execute" is a
 * statement about how fast the test ran rather than about the framework. There
 * are no arbitrary waits and no test depends on another having run.
 */

import { expect, test } from "@playwright/test";

const PAGE = "/examples/head-url-security-browser.html";

type Attrs = Record<string, string> | null;

interface Api {
  reset(): boolean;
  mixedCaseScriptSrc(): { scripts: Attrs[]; xss: boolean };
  lowerCaseScriptSrc(): { scripts: Attrs[]; xss: boolean };
  safeScriptSrc(): { scripts: Attrs[] };
  mixedCaseLinkHref(): { links: Attrs[]; xss: boolean };
  safeLinkHref(): { links: Attrs[] };
  rejectedUrlIsOmitted(): { attrs: Attrs; hasHref: boolean | null };
  reactiveMetaUrl(): { initial: Attrs; during: Attrs; after: Attrs; xss: boolean };
  xss(): boolean;
}

test.beforeEach(async ({ page }) => {
  await page.goto(PAGE);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await page.evaluate(() => (window as never as { __t: Api }).__t.reset());
});

test("control: a safe same-origin script src IS fetched and executed", async ({ page }) => {
  // Without this, every "the payload did not run" below could be satisfied by a
  // page that cannot run any injected script at all.
  const built = await page.evaluate(() => (window as never as { __t: Api }).__t.safeScriptSrc());
  expect(built.scripts, "a safe script src was suppressed").toHaveLength(1);
  expect(built.scripts[0]?.src).toBe("/examples/head-url-security-probe.js");

  await page.waitForFunction(() => (window as unknown as { __sibuSafeScriptRan?: boolean }).__sibuSafeScriptRan === true, {
    timeout: 10_000,
  });
});

test("control: a safe same-origin stylesheet IS applied", async ({ page }) => {
  const built = await page.evaluate(() => (window as never as { __t: Api }).__t.safeLinkHref());
  // Authored as `REL`/`HREF`; emitted under the canonical names.
  expect(built.links[0]).toEqual({ rel: "stylesheet", href: "/examples/head-url-security-probe.css" });

  await page.waitForFunction(
    () => getComputedStyle(document.body).backgroundColor === "rgb(1, 2, 3)",
    { timeout: 10_000 },
  );
});

test("a mixed-case script SRC carrying data: never executes", async ({ page }) => {
  // NOTE: there is deliberately no request counter here. A `data:` URL produces
  // no network request, so a counter could only ever read zero and would assert
  // nothing. The witness is the payload's own global, checked twice — once
  // synchronously, and once after a control script has demonstrably executed.
  //
  // The payload is real: Chromium, Firefox and WebKit all execute
  // `<script src="data:text/javascript,…">`, so on the vulnerable build this
  // was a working XSS rather than a theoretical one.
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.mixedCaseScriptSrc());

  // Nothing published — the entry had only the refused attribute.
  expect(result.scripts, "a script element was published for a refused src").toEqual([]);
  expect(result.xss, "the payload executed synchronously").toBe(false);

  // Now give the engine a genuine chance to run an injected script, then check
  // again: the control proves the mechanism works in this very page instance.
  await page.evaluate(() => (window as never as { __t: Api }).__t.safeScriptSrc());
  await page.waitForFunction(() => (window as unknown as { __sibuSafeScriptRan?: boolean }).__sibuSafeScriptRan === true, {
    timeout: 10_000,
  });

  expect(await page.evaluate(() => (window as never as { __t: Api }).__t.xss()), "the payload executed later").toBe(
    false,
  );
});

test("a lowercase script src carrying data: never executes either", async ({ page }) => {
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.lowerCaseScriptSrc());
  expect(result.scripts).toEqual([]);
  expect(result.xss).toBe(false);

  await page.evaluate(() => (window as never as { __t: Api }).__t.safeScriptSrc());
  await page.waitForFunction(() => (window as unknown as { __sibuSafeScriptRan?: boolean }).__sibuSafeScriptRan === true, {
    timeout: 10_000,
  });
  expect(await page.evaluate(() => (window as never as { __t: Api }).__t.xss())).toBe(false);
});

test("a mixed-case link HREF carrying javascript: is dropped, keeping its siblings", async ({ page }) => {
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.mixedCaseLinkHref());

  // The safe half of the entry survives; only the refused URL is gone.
  expect(result.links).toEqual([{ rel: "stylesheet" }]);
  expect(result.xss).toBe(false);

  // Prove the stylesheet mechanism works here, then re-check.
  await page.evaluate(() => (window as never as { __t: Api }).__t.safeLinkHref());
  await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === "rgb(1, 2, 3)", {
    timeout: 10_000,
  });
  expect(await page.evaluate(() => (window as never as { __t: Api }).__t.xss())).toBe(false);
});

test("a refused URL is omitted, not published as an empty one", async ({ page }) => {
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.rejectedUrlIsOmitted());

  // `href=""` is not "no href": an empty URL attribute resolves against the
  // current document, so `<link rel="icon" href="">` would make the browser
  // request the page itself as a favicon.
  expect(result.hasHref, "a refused URL was published as an empty string").toBe(false);
  expect(result.attrs).toEqual({ rel: "icon" });
});

test("a reactive meta URL never publishes the unsafe value", async ({ page }) => {
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.reactiveMetaUrl());

  expect(result.initial).toEqual({ name: "probe", href: "/a.css" });
  // Omitted while unsafe — the rest of the entry stays.
  expect(result.during).toEqual({ name: "probe" });
  // Restored when safe again.
  expect(result.after).toEqual({ name: "probe", href: "/b.css" });
  expect(result.xss).toBe(false);
});
