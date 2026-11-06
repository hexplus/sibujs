/**
 * Real-browser validation that commits survive synchronous custom-element
 * reactions — Chromium, Firefox, WebKit.
 *
 * Removing or inserting a custom element runs its `disconnectedCallback` /
 * `connectedCallback` before the DOM operation returns. The jsdom suite
 * (`tests/custom-element-commit-callbacks.test.ts`) is the exhaustive one; this
 * file checks the same outcomes on real engines' reaction timing:
 *
 * - a `connectedCallback` disposing the renderer during the insertion releases
 *   the incoming content once — core `lazy()` and `Suspense`, `Route`, nested
 *   `Outlet`, router `Suspense` — and the work it captured stops reacting;
 * - a `disconnectedCallback` disposing the renderer during the staged
 *   replacement (core `Suspense` whose content is its fallback's own root)
 *   discards the content once and never re-inserts it;
 * - a cached `KeepAliveRoute` page whose disconnection disposes the outlet is
 *   released with it, once.
 */
import { expect, type Page, test } from "@playwright/test";

const FIXTURE = "/examples/custom-element-commit-browser.html";

const call = <R = unknown>(page: Page, name: string) =>
  page.evaluate(
    (n) => (window as never as { __t: Record<string, () => unknown> }).__t[n](),
    name,
  ) as Promise<R>;

interface Report {
  state: string | null;
  reacted: boolean;
  cleanups: number;
}
interface Counts {
  connected: number;
  disconnected: number;
}

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
  await page.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true);
});

test("core lazy(): a connectedCallback disposing the container ends the instance once", async ({ page }) => {
  const r = await call<Report & { rootCleanups: number; counts: Counts; cleanupsAfter: number }>(
    page,
    "lazyConnectedDispose",
  );
  expect(r.counts.connected).toBe(1);
  expect(r.rootCleanups).toBe(1);
  expect(r.state).toBe("ended");
  expect(r.reacted).toBe(false);
  expect(r.cleanups).toBe(1);
  expect(r.cleanupsAfter).toBe(1);
});

test("core lazy(): repeated mounts whose connection disposes them all end", async ({ page }) => {
  const r = await call<{ states: string[]; cleanups: number }>(page, "lazyRepeated");
  expect(r.states).toEqual(["ended", "ended", "ended", "ended"]);
  expect(r.cleanups).toBe(4);
});

test("core Suspense: content that is its fallback's root, disposing the boundary on disconnection, is never re-inserted", async ({
  page,
}) => {
  const r = await call<
    Report & { initial: boolean; children: number; connected: boolean; rootCleanups: number; counts: Counts }
  >(page, "suspenseSharedRoot");
  expect(r.initial).toBe(true);
  expect(r.children).toBe(0);
  expect(r.connected).toBe(false);
  expect(r.rootCleanups).toBe(1);
  expect(r.counts).toEqual({ connected: 1, disconnected: 1 });
  expect(r.state).toBe("ended");
  expect(r.reacted).toBe(false);
  expect(r.cleanups).toBe(1);
});

test("core Suspense: a content connectedCallback disposing the boundary ends content and fallback once", async ({
  page,
}) => {
  const r = await call<{ rootCleanups: number; content: Report; fallback: Report }>(page, "suspenseConnectedDispose");
  expect(r.rootCleanups).toBe(1);
  for (const w of [r.content, r.fallback]) {
    expect(w.state).toBe("ended");
    expect(w.reacted).toBe(false);
    expect(w.cleanups).toBe(1);
  }
});

test("Route: a connectedCallback disposing the outlet releases the page once", async ({ page }) => {
  const r = await call<Report & { rootCleanups: number; counts: Counts; children: number }>(
    page,
    "routeConnectedDispose",
  );
  expect(r.counts.connected).toBe(1);
  expect(r.rootCleanups).toBe(1);
  expect(r.children).toBe(1);
  expect(r.state).toBe("ended");
  expect(r.reacted).toBe(false);
  expect(r.cleanups).toBe(1);
});

test("Outlet: a connectedCallback disposing the nested outlet releases the child once", async ({ page }) => {
  const r = await call<Report & { rootCleanups: number; counts: Counts; layoutChildren: number }>(
    page,
    "outletConnectedDispose",
  );
  expect(r.counts.connected).toBe(1);
  expect(r.rootCleanups).toBe(1);
  expect(r.layoutChildren).toBe(1);
  expect(r.state).toBe("ended");
  expect(r.reacted).toBe(false);
  expect(r.cleanups).toBe(1);
});

test("KeepAliveRoute: a cached page whose disconnection disposes the outlet is released once", async ({ page }) => {
  const r = await call<Report & { rootCleanups: number; b: boolean }>(page, "keepAliveDisconnectDispose");
  expect(r.rootCleanups).toBe(1);
  expect(r.b).toBe(false);
  expect(r.state).toBe("ended");
  expect(r.reacted).toBe(false);
  expect(r.cleanups).toBe(1);
});

test("router Suspense: a connectedCallback disposing the boundary releases the content once", async ({ page }) => {
  const r = await call<{ rootCleanups: number; counts: Counts; children: number }>(
    page,
    "routerSuspenseConnectedDispose",
  );
  expect(r.counts.connected).toBe(1);
  expect(r.rootCleanups).toBe(1);
  expect(r.children).toBe(1);
});

const callWith = <R = unknown>(page: Page, name: string, arg: string) =>
  page.evaluate(
    ([n, a]) => (window as never as { __t: Record<string, (x: string) => unknown> }).__t[n](a),
    [name, arg] as const,
  ) as Promise<R>;

for (const kind of ["when", "match"]) {
  test(`${kind}(): a connectedCallback disposing the directive releases the whole incoming fragment once`, async ({
    page,
  }) => {
    const r = await callWith<{
      headCleanups: number;
      tailCleanups: number;
      counts: Counts;
      elements: number;
      reacted: boolean;
      text: string;
    }>(page, "directiveFragmentConnectedDispose", kind);
    expect(r.counts.connected).toBe(1);
    expect(r.headCleanups).toBe(1);
    expect(r.tailCleanups).toBe(1);
    expect(r.elements).toBe(0);
    expect(r.reacted).toBe(false);
    expect(r.text).not.toContain("tail-1");
  });
}

for (const mode of ["both", "out-in"]) {
  test(`when(): a leave disposing the directive builds no replacement (mode ${mode})`, async ({ page }) => {
    const r = await callWith<{ replacements: number; initialCleanups: number; elements: number }>(
      page,
      "directiveLeaveDisposes",
      mode,
    );
    expect(r.replacements).toBe(0);
    expect(r.initialCleanups).toBe(1);
    expect(r.elements).toBe(0);
  });
}

test("when(): a nested range emptied while its branch leaves is taken back empty", async ({ page }) => {
  const r = await call<{ before: number; after: number; refilled: number; anchored: boolean }>(
    page,
    "directiveReclaimEmptiedRange",
  );
  expect(r.before).toBe(1);
  expect(r.after).toBe(0);
  expect(r.refilled).toBe(1);
  expect(r.anchored).toBe(true);
});

for (const kind of ["when", "match"]) {
  test(`${kind}(): an out-in build whose factory selects nothing is never inserted`, async ({ page }) => {
    const r = await callWith<{ connected: number; cleanups: number; elements: number; text: string }>(
      page,
      "directiveObsoleteBuild",
      kind,
    );
    expect(r.connected).toBe(0);
    expect(r.cleanups).toBe(1);
    expect(r.elements).toBe(0);
    expect(r.text).toBe("");
  });

  for (const mode of ["in-out", "both"]) {
    test(`${kind}(): an enter that switches from its own callback is obsolete (mode ${mode})`, async ({ page }) => {
      const r = await callWith<{
        enters: string[];
        leavesWhileBEnters: number;
        leavesAfterBEntered: number;
        timersRunning: number;
        timersAfterDispose: number;
        leavesAtEnd: number;
        elements: number;
      }>(page, "directiveEnterSwitches", `${kind}:${mode}`);
      expect(r.enters).toEqual(["a", "b"]);
      if (mode === "in-out") {
        // B's enter alone runs; A's leave waits for it, then starts once.
        expect(r.leavesWhileBEnters).toBe(0);
        expect(r.timersRunning).toBe(1);
      } else {
        // B's enter and A's leave run side by side.
        expect(r.leavesWhileBEnters).toBe(1);
        expect(r.timersRunning).toBe(2);
      }
      expect(r.leavesAfterBEntered).toBe(1);
      // Disposal cancelled the phase still running: no timer is left.
      expect(r.timersAfterDispose).toBe(0);
      expect(r.leavesAtEnd).toBe(1);
      expect(r.elements).toBe(0);
    });
  }
}
