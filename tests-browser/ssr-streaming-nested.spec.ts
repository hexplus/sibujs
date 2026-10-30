import { expect, test } from "@playwright/test";

// A nested Suspense boundary that resolves before the one around it. The page
// is streamed on the server side of the test (Node, the built package, its
// server DOM) and loaded into a real browser, which runs the swap scripts
// natively: each boundary's content must end up there once, with no hidden
// payload left over.

type Modules = [typeof import("../dist/index.js"), typeof import("../dist/data.js"), typeof import("../dist/ssr.js")];

async function streamNested(): Promise<string> {
  const [m, d, s] = (await Promise.all([
    import("../dist/index.js"),
    import("../dist/data.js"),
    import("../dist/ssr.js"),
  ])) as Modules;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const boundary = (name: string, ready: Promise<string>, children: Node[] = []) =>
    m.Suspense({
      nodes: () => {
        const q = d.query(`/api/${name}`, () => ready);
        return m.div({ class: `content-${name}` }, [
          m.span({ class: `text-${name}` }, () => q.data() ?? ""),
          m.button({ id: `btn-${name}` }, name),
          ...children,
        ]);
      },
      fallback: () => m.p({ class: `fallback-${name}` }, `loading ${name}`),
    } as never);
  const reader = s
    .renderToReadableStream(() =>
      m.section([
        boundary(
          "outer",
          wait(180).then(() => "outer data"),
          [boundary("inner", wait(40).then(() => "inner data"))],
        ),
      ]),
    )
    .getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += value;
  }
}

test("an inner boundary ready before its outer one is swapped in exactly once", async ({ page }) => {
  const html = await streamNested();
  await page.setContent(html);
  await expect(page.locator(".text-outer")).toHaveText("outer data");
  await expect(page.locator(".text-inner")).toHaveText("inner data");
  await expect(page.locator("#btn-inner")).toHaveCount(1);
  await expect(page.locator("#btn-outer")).toHaveCount(1);
  await expect(page.locator("[id^=sibu-resolved-]")).toHaveCount(0);
  await expect(page.locator(".fallback-outer, .fallback-inner")).toHaveCount(0);
});
