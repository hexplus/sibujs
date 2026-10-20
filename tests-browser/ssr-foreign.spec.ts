/**
 * SSR output for SVG and MathML, parsed by each engine's own HTML parser.
 *
 * jsdom's parser is an implementation of the same algorithm, but the property
 * that matters — the namespace each element comes back in, and where foreign
 * content ends — is decided by the browser that receives the HTML. Each case
 * renders a tree with the built `renderToString`, parses the string with the
 * engine's `DOMParser`, and compares namespace, local name, attributes (with
 * their namespaces) and children.
 *
 * The hostile case proves that SVG-namespace elements named like HTML ones
 * (`meta`, `link`, `base`, `p`) and an HTML element placed directly in SVG never
 * come back as live HTML, and that content after them stays SVG.
 */

import { expect, type Page, test } from "@playwright/test";

const PAGE = "/examples/ssr-foreign-browser.html";

type Api = {
  roundTrip(name: string): { source: unknown; parsed: unknown };
  hostile(): { htmlNamed: string[]; evil: boolean; circleNs: string | null; svgLinkNs: string | null };
};

async function open(page: Page) {
  await page.goto(PAGE);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
}

for (const name of ["icon", "xlinkAndXmlns", "foreignObject", "mathml"]) {
  test(`${name}: the parsed server output equals the source tree`, async ({ page }) => {
    await open(page);
    const { source, parsed } = await page.evaluate((n) => (window as never as { __t: Api }).__t.roundTrip(n), name);
    expect(parsed).toEqual(source);
  });
}

test("hostile foreign content never becomes live HTML", async ({ page }) => {
  await open(page);
  const result = await page.evaluate(() => (window as never as { __t: Api }).__t.hostile());
  expect(result.htmlNamed).toEqual([]);
  expect(result.evil).toBe(false);
  // Nothing broke out of the <svg>: the trailing circle and the inert link are SVG.
  expect(result.circleNs).toBe("http://www.w3.org/2000/svg");
  expect(result.svgLinkNs).toBe("http://www.w3.org/2000/svg");
});
