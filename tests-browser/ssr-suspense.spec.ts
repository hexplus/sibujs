/**
 * ST-004 — SSR Suspense fallback replacement, verified in real browsers.
 *
 * The swap protocol ships an inline `<script>` that patches the boundary once
 * the resolved payload arrives. Asserting on the stream *string* proves
 * nothing about that script's effect, so these tests inject the streamed HTML
 * into a live document, let the script execute, and assert the resulting DOM.
 */
import { expect, test } from "@playwright/test";

const FIXTURE = "/examples/ssr-suspense-browser.html";

interface Counts {
  fallback: number;
  resolved: number;
  markers: number;
  payloads: number;
  text: string;
  pwned: boolean;
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true);
});

const run = async (page: import("@playwright/test").Page, scenario: string): Promise<Counts> => {
  await page.evaluate(async (s) => {
    const api = (window as never as { __t: Record<string, () => Promise<void>> }).__t;
    await api[s]();
  }, scenario);
  return page.evaluate(() => (window as never as { __t: { counts: () => Counts } }).__t.counts());
};

test.describe("SSR Suspense swap", () => {
  test("replaces the fallback with resolved content", async ({ page }) => {
    const c = await run(page, "simple");

    // INVARIANT: resolution REPLACES the fallback — it does not append beside it.
    expect(c.fallback).toBe(0);
    expect(c.resolved).toBe(1);
    expect(c.text).toContain("Done");
    expect(c.text).not.toContain("Loading");
  });

  test("removes the boundary marker and the payload wrapper", async ({ page }) => {
    const c = await run(page, "simple");

    expect(c.markers).toBe(0);
    expect(c.payloads).toBe(0);
  });

  test("moves every node of multi-node resolved content", async ({ page }) => {
    const c = await run(page, "multiNode");

    expect(c.fallback).toBe(0);
    expect(c.resolved).toBe(3);
    expect(c.text).toContain("One");
    expect(c.text).toContain("Two");
    expect(c.text).toContain("Three");
  });

  test("keeps sibling boundaries independent", async ({ page }) => {
    const c = await run(page, "siblings");

    expect(c.fallback).toBe(0);
    expect(c.resolved).toBe(2);
    expect(c.text).toContain("DoneA");
    expect(c.text).toContain("DoneB");
    expect(c.text).not.toContain("LoadA");
    expect(c.text).not.toContain("LoadB");
  });

  test("removes the fallback even when resolved content is empty", async ({ page }) => {
    const c = await run(page, "emptyResolved");

    // An empty resolution must still clear the loading state.
    expect(c.fallback).toBe(0);
    expect(c.text).not.toContain("Loading");
  });

  test("is idempotent — re-running the swap does not duplicate content", async ({ page }) => {
    await run(page, "simple");

    // Re-execute the same swap payload. The protocol keys off the payload
    // wrapper, which the first run removed, so this is a no-op.
    const c = await page.evaluate(() => {
      const out = document.getElementById("out")!;
      const scripts = Array.from(out.querySelectorAll("script"));
      for (const old of scripts) {
        const s = document.createElement("script");
        s.textContent = old.textContent;
        out.appendChild(s);
      }
      return (window as never as { __t: { counts: () => Counts } }).__t.counts();
    });

    expect(c.fallback).toBe(0);
    expect(c.resolved).toBe(1);
  });

  test("keeps hostile resolved content escaped and inert", async ({ page }) => {
    const c = await run(page, "hostileResolved");

    expect(c.fallback).toBe(0);
    expect(c.pwned).toBe(false);
    // The payload survives as text, never as executable markup.
    expect(c.text).toContain("window.__pwned=1");
  });
});
