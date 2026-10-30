import { expect, type Page, test } from "@playwright/test";

// Adopting hydration and native <select> behavior in a real browser: the
// selection the user made with the real control before takeover — an emptied
// multiple select, the second of two equal-valued options — survives it, node
// for node. The markup is rendered with `renderToStringAsync(…, { hydration:
// "adopt" })` in the page itself, then taken over with `hydrate(…, { strategy:
// "adopt" })` from the built package.

type Win = Window & {
  __sibu: { render: (name: string) => Promise<void>; take: (name: string) => Promise<void> };
  __seen: Record<string, number[]>;
};

async function setup(page: Page): Promise<void> {
  await page.goto("/examples/islands-lazy.html");
  await page.evaluate(async () => {
    const m = await import("/dist/index.js" as string);
    const s = await import("/dist/ssr.js" as string);
    const w = window as unknown as Win;
    w.__seen = {};
    const seen = (name: string) => (e: Event) => {
      const el = e.target as HTMLSelectElement;
      w.__seen[name] = [...(w.__seen[name] ?? []), el.multiple ? el.selectedOptions.length : el.selectedIndex];
    };
    const apps: Record<string, () => Node> = {
      duplicate: () =>
        m.select({ on: { change: seen("duplicate") } }, [
          m.option({ value: "same" }, "First"),
          m.option({ value: "same" }, "Second"),
        ]),
      cleared: () =>
        m.select({ multiple: true, on: { change: seen("cleared") } }, [
          m.option({ value: "a" }, "A"),
          m.option({ value: "b" }, "B"),
        ]),
    };
    w.__sibu = {
      async render(name) {
        const host = document.createElement("div");
        host.id = name;
        let { html } = await s.renderToStringAsync(apps[name], { hydration: "adopt" });
        // A multiple select's server-side selection, as delivered markup.
        if (name === "cleared") html = html.replace('<option value="a"', '<option value="a" selected');
        host.innerHTML = html;
        document.body.appendChild(host);
      },
      async take(name) {
        await s.hydrate(apps[name], document.getElementById(name), { strategy: "adopt" });
      },
    };
  });
}

test("keeps the second of two equal-valued options chosen with the real control", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => (window as unknown as Win).__sibu.render("duplicate"));
  const sel = page.locator("#duplicate select");
  await expect(sel).toHaveJSProperty("selectedIndex", 0);
  await sel.selectOption({ index: 1 });
  await page.evaluate(() => {
    (window as unknown as { __second: Element }).__second = document.querySelectorAll("#duplicate option")[1];
  });
  await page.evaluate(() => (window as unknown as Win).__sibu.take("duplicate"));
  await expect(page.locator("#duplicate")).toHaveAttribute("data-sibu-hydrated", "adopt");
  await expect(sel).toHaveJSProperty("selectedIndex", 1);
  expect(
    await page.evaluate(() => {
      const el = document.querySelector("#duplicate select") as HTMLSelectElement;
      const second = (window as unknown as { __second: Element }).__second;
      return { same: el.selectedOptions[0] === second, count: el.selectedOptions.length };
    }),
  ).toEqual({ same: true, count: 1 });
  // The handler did not exist when the user chose; the replayed change told it, with index 1.
  expect(await page.evaluate(() => (window as unknown as Win).__seen.duplicate)).toEqual([1]);
});

test("keeps a multiple select the user emptied with the real control", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => (window as unknown as Win).__sibu.render("cleared"));
  const sel = page.locator("#cleared select");
  expect(await sel.evaluate((el: HTMLSelectElement) => el.selectedOptions.length)).toBe(1);
  await sel.selectOption([]);
  await page.evaluate(() => (window as unknown as Win).__sibu.take("cleared"));
  await expect(page.locator("#cleared")).toHaveAttribute("data-sibu-hydrated", "adopt");
  expect(
    await page.evaluate(() => (document.querySelector("#cleared select") as HTMLSelectElement).selectedOptions.length),
  ).toBe(0);
  // The replayed change reported the empty selection.
  expect(await page.evaluate(() => (window as unknown as Win).__seen.cleared)).toEqual([0]);
});
